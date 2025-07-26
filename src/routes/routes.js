const express = require('express');
const Joi = require('joi');
const { query, transaction } = require('../database/connection');
const { authenticate, authorize } = require('../middleware/auth');
const { sendNotification, sendBulkNotifications } = require('../services/communications');
const logger = require('../utils/logger');
const geolib = require('geolib');

const router = express.Router();

// Route optimization algorithm
const optimizeRoute = (orders, startLocation) => {
  if (orders.length <= 1) return orders;

  // Simple nearest neighbor algorithm for route optimization
  const optimizedRoute = [];
  let currentLocation = startLocation;
  let remainingOrders = [...orders];

  while (remainingOrders.length > 0) {
    let nearestIndex = 0;
    let nearestDistance = Infinity;

    remainingOrders.forEach((order, index) => {
      const distance = geolib.getDistance(
        currentLocation,
        { latitude: order.pickup_latitude, longitude: order.pickup_longitude }
      );

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });

    const nearestOrder = remainingOrders.splice(nearestIndex, 1)[0];
    optimizedRoute.push(nearestOrder);
    currentLocation = {
      latitude: nearestOrder.delivery_latitude,
      longitude: nearestOrder.delivery_longitude
    };
  }

  return optimizedRoute;
};

// Create optimized route (admin only)
router.post('/optimize', authenticate, authorize('admin'), async (req, res) => {
  try {
    const schema = Joi.object({
      route_date: Joi.date().required(),
      district: Joi.string().optional(),
      max_orders_per_route: Joi.number().integer().min(1).max(20).default(12),
      vehicle_type: Joi.string().valid('ev', 'bike', 'van').default('ev'),
      agent_id: Joi.string().uuid().optional()
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Get confirmed orders for the specified date
    let whereConditions = ['o.status = $1'];
    let params = ['confirmed'];
    let paramCount = 1;

    if (value.district) {
      paramCount++;
      whereConditions.push(`f.district = $${paramCount}`);
      params.push(value.district);
    }

    // Get orders that need routing
    const ordersToRoute = await query(
      `SELECT o.*, 
              ST_X(o.pickup_location::geometry) as pickup_longitude,
              ST_Y(o.pickup_location::geometry) as pickup_latitude,
              ST_X(o.delivery_location::geometry) as delivery_longitude,
              ST_Y(o.delivery_location::geometry) as delivery_latitude,
              f.name as farmer_name, f.village,
              v.business_name, v.address as vendor_address
       FROM orders o
       JOIN farmers f ON o.farmer_id = f.id
       JOIN vendors v ON o.vendor_id = v.id
       LEFT JOIN route_orders ro ON o.id = ro.order_id
       WHERE ${whereConditions.join(' AND ')} AND ro.id IS NULL
       ORDER BY o.created_at`,
      params
    );

    if (ordersToRoute.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No orders available for routing'
      });
    }

    // Get available agents
    const availableAgents = await query(
      `SELECT a.*, ST_X(a.current_location::geometry) as longitude,
              ST_Y(a.current_location::geometry) as latitude
       FROM agents a
       WHERE a.is_available = true ${value.agent_id ? 'AND a.id = $' + (paramCount + 1) : ''}
       ORDER BY a.rating DESC`,
      value.agent_id ? [...params, value.agent_id] : params
    );

    if (availableAgents.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No agents available for routing'
      });
    }

    const routes = [];
    const orders = ordersToRoute.rows;
    let orderIndex = 0;

    // Create routes for each available agent
    for (const agent of availableAgents.rows) {
      if (orderIndex >= orders.length) break;

      const routeOrders = orders.slice(orderIndex, orderIndex + value.max_orders_per_route);
      orderIndex += routeOrders.length;

      // Optimize route order
      const startLocation = {
        latitude: agent.latitude || 0,
        longitude: agent.longitude || 0
      };

      const optimizedOrders = optimizeRoute(routeOrders, startLocation);

      // Calculate route metrics
      let totalDistance = 0;
      let estimatedDuration = 0;

      for (let i = 0; i < optimizedOrders.length; i++) {
        const order = optimizedOrders[i];
        const prevLocation = i === 0 ? startLocation : {
          latitude: optimizedOrders[i - 1].delivery_latitude,
          longitude: optimizedOrders[i - 1].delivery_longitude
        };

        const pickupDistance = geolib.getDistance(prevLocation, {
          latitude: order.pickup_latitude,
          longitude: order.pickup_longitude
        });

        const deliveryDistance = geolib.getDistance(
          { latitude: order.pickup_latitude, longitude: order.pickup_longitude },
          { latitude: order.delivery_latitude, longitude: order.delivery_longitude }
        );

        totalDistance += (pickupDistance + deliveryDistance) / 1000; // Convert to km
        estimatedDuration += Math.ceil((pickupDistance + deliveryDistance) / 1000 * 2); // 2 minutes per km
      }

      routes.push({
        agent,
        orders: optimizedOrders,
        totalDistance,
        estimatedDuration
      });
    }

    // Create routes in database
    const createdRoutes = await transaction(async (client) => {
      const routeResults = [];

      for (const routeData of routes) {
        // Create route
        const routeName = `${routeData.agent.name}_${value.route_date}_${Date.now()}`;
        const routeInsert = await client.query(
          `INSERT INTO routes 
           (route_name, agent_id, route_date, start_location, total_distance, estimated_duration, vehicle_type)
           VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), $6, $7, $8)
           RETURNING *`,
          [
            routeName,
            routeData.agent.id,
            value.route_date,
            routeData.agent.longitude || 0,
            routeData.agent.latitude || 0,
            routeData.totalDistance,
            routeData.estimatedDuration,
            value.vehicle_type
          ]
        );

        const route = routeInsert.rows[0];

        // Add orders to route
        for (let i = 0; i < routeData.orders.length; i++) {
          const order = routeData.orders[i];
          const pickupEta = new Date();
          pickupEta.setMinutes(pickupEta.getMinutes() + (i * 30)); // 30 minutes per order

          const deliveryEta = new Date(pickupEta);
          deliveryEta.setMinutes(deliveryEta.getMinutes() + 20); // 20 minutes for delivery

          await client.query(
            `INSERT INTO route_orders 
             (route_id, order_id, sequence_number, pickup_eta, delivery_eta)
             VALUES ($1, $2, $3, $4, $5)`,
            [route.id, order.id, i + 1, pickupEta, deliveryEta]
          );
        }

        routeResults.push({
          route,
          order_count: routeData.orders.length,
          total_distance: routeData.totalDistance,
          estimated_duration: routeData.estimatedDuration
        });
      }

      return routeResults;
    });

    // Send notifications to agents
    const agentNotifications = createdRoutes.map(routeResult => {
      const agent = routes.find(r => r.agent.id === routeResult.route.agent_id).agent;
      return sendNotification(
        agent.user_id,
        `New route assigned: ${routeResult.order_count} pickups scheduled for ${value.route_date}`,
        'route_assigned',
        'normal'
      );
    });

    await Promise.allSettled(agentNotifications);

    res.status(201).json({
      success: true,
      message: `${createdRoutes.length} routes created successfully`,
      data: createdRoutes
    });

  } catch (error) {
    logger.error('Route optimization error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to optimize routes'
    });
  }
});

// Get route details
router.get('/:routeId', authenticate, async (req, res) => {
  try {
    const { routeId } = req.params;

    // Check user access
    let accessQuery = 'SELECT r.* FROM routes r WHERE r.id = $1';
    let params = [routeId];

    if (req.user.user_type === 'agent') {
      accessQuery += ' AND r.agent_id = (SELECT id FROM agents WHERE user_id = $2)';
      params.push(req.user.id);
    }

    const route = await query(accessQuery, params);

    if (route.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Route not found or access denied'
      });
    }

    // Get route orders with details
    const routeOrders = await query(
      `SELECT ro.*, o.order_number, o.quantity, o.total_amount, o.status,
              p.name as product_name, p.unit,
              f.name as farmer_name, f.village, f.phone_number as farmer_phone,
              v.business_name, v.address as vendor_address, v.phone_number as vendor_phone,
              ST_X(o.pickup_location::geometry) as pickup_longitude,
              ST_Y(o.pickup_location::geometry) as pickup_latitude,
              ST_X(o.delivery_location::geometry) as delivery_longitude,
              ST_Y(o.delivery_location::geometry) as delivery_latitude
       FROM route_orders ro
       JOIN orders o ON ro.order_id = o.id
       JOIN product_listings pl ON o.product_listing_id = pl.id
       JOIN products p ON pl.product_id = p.id
       JOIN farmers f ON o.farmer_id = f.id
       JOIN users uf ON f.user_id = uf.id
       JOIN vendors v ON o.vendor_id = v.id
       JOIN users uv ON v.user_id = uv.id
       WHERE ro.route_id = $1
       ORDER BY ro.sequence_number`,
      [routeId]
    );

    // Get agent details
    const agent = await query(
      `SELECT a.*, u.phone_number,
              ST_X(a.current_location::geometry) as current_longitude,
              ST_Y(a.current_location::geometry) as current_latitude
       FROM agents a
       JOIN users u ON a.user_id = u.id
       WHERE a.id = $1`,
      [route.rows[0].agent_id]
    );

    res.json({
      success: true,
      data: {
        route: route.rows[0],
        agent: agent.rows[0],
        orders: routeOrders.rows
      }
    });

  } catch (error) {
    logger.error('Get route details error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch route details'
    });
  }
});

// Get all routes (admin only)
router.get('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { 
      status, 
      date, 
      agent_id, 
      district,
      page = 1, 
      limit = 20 
    } = req.query;
    
    const offset = (page - 1) * limit;

    let whereConditions = [];
    let params = [];
    let paramCount = 0;

    if (status) {
      paramCount++;
      whereConditions.push(`r.status = $${paramCount}`);
      params.push(status);
    }

    if (date) {
      paramCount++;
      whereConditions.push(`r.route_date = $${paramCount}`);
      params.push(date);
    }

    if (agent_id) {
      paramCount++;
      whereConditions.push(`r.agent_id = $${paramCount}`);
      params.push(agent_id);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const routes = await query(
      `SELECT r.*, a.name as agent_name, a.vehicle_number,
              COUNT(ro.id) as total_orders,
              COUNT(CASE WHEN ro.actual_pickup_time IS NOT NULL THEN 1 END) as completed_pickups,
              COUNT(CASE WHEN ro.actual_delivery_time IS NOT NULL THEN 1 END) as completed_deliveries,
              COALESCE(SUM(o.pickup_margin), 0) as total_earnings
       FROM routes r
       JOIN agents a ON r.agent_id = a.id
       LEFT JOIN route_orders ro ON r.id = ro.route_id
       LEFT JOIN orders o ON ro.order_id = o.id
       ${whereClause}
       GROUP BY r.id, a.name, a.vehicle_number
       ORDER BY r.route_date DESC, r.created_at DESC
       LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`,
      [...params, limit, offset]
    );

    // Get total count for pagination
    const totalResult = await query(
      `SELECT COUNT(DISTINCT r.id) as total FROM routes r
       JOIN agents a ON r.agent_id = a.id
       ${whereClause}`,
      params
    );

    res.json({
      success: true,
      data: {
        routes: routes.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(totalResult.rows[0].total),
          pages: Math.ceil(totalResult.rows[0].total / limit)
        }
      }
    });

  } catch (error) {
    logger.error('Get routes error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch routes'
    });
  }
});

// Update route status (admin only)
router.put('/:routeId/status', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { routeId } = req.params;
    const schema = Joi.object({
      status: Joi.string().valid('planned', 'active', 'completed', 'cancelled').required(),
      notes: Joi.string().max(500).optional()
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const result = await transaction(async (client) => {
      // Update route status
      const routeUpdate = await client.query(
        'UPDATE routes SET status = $1 WHERE id = $2 RETURNING *',
        [value.status, routeId]
      );

      if (routeUpdate.rows.length === 0) {
        throw new Error('Route not found');
      }

      const route = routeUpdate.rows[0];

      // Update agent availability based on status
      if (value.status === 'completed' || value.status === 'cancelled') {
        await client.query(
          'UPDATE agents SET is_available = true WHERE id = $1',
          [route.agent_id]
        );
      } else if (value.status === 'active') {
        await client.query(
          'UPDATE agents SET is_available = false WHERE id = $1',
          [route.agent_id]
        );
      }

      return route;
    });

    // Notify agent about status change
    const agent = await query(
      'SELECT user_id FROM agents WHERE id = $1',
      [result.agent_id]
    );

    if (agent.rows.length > 0) {
      await sendNotification(
        agent.rows[0].user_id,
        `Route status updated to: ${value.status}. ${value.notes || ''}`,
        'route_status_updated'
      );
    }

    res.json({
      success: true,
      message: 'Route status updated successfully',
      data: result
    });

  } catch (error) {
    logger.error('Update route status error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update route status'
    });
  }
});

// Reassign route to different agent (admin only)
router.put('/:routeId/reassign', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { routeId } = req.params;
    const schema = Joi.object({
      new_agent_id: Joi.string().uuid().required(),
      reason: Joi.string().max(500).optional()
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Check if new agent is available
    const newAgent = await query(
      'SELECT * FROM agents WHERE id = $1 AND is_available = true',
      [value.new_agent_id]
    );

    if (newAgent.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Selected agent is not available'
      });
    }

    const result = await transaction(async (client) => {
      // Get current route details
      const currentRoute = await client.query(
        'SELECT * FROM routes WHERE id = $1',
        [routeId]
      );

      if (currentRoute.rows.length === 0) {
        throw new Error('Route not found');
      }

      const route = currentRoute.rows[0];

      // Update route agent
      const routeUpdate = await client.query(
        'UPDATE routes SET agent_id = $1 WHERE id = $2 RETURNING *',
        [value.new_agent_id, routeId]
      );

      // Update agent availability
      await client.query(
        'UPDATE agents SET is_available = true WHERE id = $1',
        [route.agent_id]
      );

      await client.query(
        'UPDATE agents SET is_available = false WHERE id = $1',
        [value.new_agent_id]
      );

      return { route: routeUpdate.rows[0], oldAgentId: route.agent_id };
    });

    // Send notifications
    const [oldAgent, newAgentUser] = await Promise.all([
      query('SELECT user_id FROM agents WHERE id = $1', [result.oldAgentId]),
      query('SELECT user_id FROM agents WHERE id = $1', [value.new_agent_id])
    ]);

    const notifications = [];
    
    if (oldAgent.rows.length > 0) {
      notifications.push(
        sendNotification(
          oldAgent.rows[0].user_id,
          `Route reassigned. ${value.reason || 'No reason provided'}`,
          'route_reassigned'
        )
      );
    }

    if (newAgentUser.rows.length > 0) {
      notifications.push(
        sendNotification(
          newAgentUser.rows[0].user_id,
          `New route assigned to you. Please check your dashboard.`,
          'route_assigned'
        )
      );
    }

    await Promise.allSettled(notifications);

    res.json({
      success: true,
      message: 'Route reassigned successfully',
      data: result.route
    });

  } catch (error) {
    logger.error('Reassign route error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to reassign route'
    });
  }
});

// Get route analytics (admin only)
router.get('/analytics/summary', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { period = '30', district, agent_id } = req.query;

    let whereConditions = [`r.route_date >= CURRENT_DATE - INTERVAL '${period} days'`];
    let params = [];
    let paramCount = 0;

    if (district) {
      // This would require joining with orders and farmers tables
      paramCount++;
      whereConditions.push(`EXISTS (
        SELECT 1 FROM route_orders ro 
        JOIN orders o ON ro.order_id = o.id 
        JOIN farmers f ON o.farmer_id = f.id 
        WHERE ro.route_id = r.id AND f.district = $${paramCount}
      )`);
      params.push(district);
    }

    if (agent_id) {
      paramCount++;
      whereConditions.push(`r.agent_id = $${paramCount}`);
      params.push(agent_id);
    }

    const [
      routeStats,
      efficiencyStats,
      dailyTrend,
      agentPerformance
    ] = await Promise.all([
      // Overall route statistics
      query(
        `SELECT 
           COUNT(*) as total_routes,
           COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_routes,
           COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_routes,
           COALESCE(AVG(total_distance), 0) as avg_distance,
           COALESCE(AVG(estimated_duration), 0) as avg_duration,
           COALESCE(SUM(fuel_cost), 0) as total_fuel_cost
         FROM routes r
         WHERE ${whereConditions.join(' AND ')}`,
        params
      ),

      // Efficiency statistics
      query(
        `SELECT 
           COUNT(ro.id) as total_orders,
           COUNT(CASE WHEN ro.actual_pickup_time IS NOT NULL THEN 1 END) as successful_pickups,
           COUNT(CASE WHEN ro.actual_delivery_time IS NOT NULL THEN 1 END) as successful_deliveries,
           COALESCE(AVG(EXTRACT(EPOCH FROM (ro.actual_pickup_time - ro.pickup_eta))/60), 0) as avg_pickup_delay,
           COALESCE(AVG(EXTRACT(EPOCH FROM (ro.actual_delivery_time - ro.delivery_eta))/60), 0) as avg_delivery_delay
         FROM routes r
         LEFT JOIN route_orders ro ON r.id = ro.route_id
         WHERE ${whereConditions.join(' AND ')}`,
        params
      ),

      // Daily route trend
      query(
        `SELECT DATE(r.route_date) as route_date,
                COUNT(*) as daily_routes,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_routes,
                COALESCE(AVG(total_distance), 0) as avg_distance
         FROM routes r
         WHERE ${whereConditions.join(' AND ')}
         GROUP BY DATE(r.route_date)
         ORDER BY route_date`,
        params
      ),

      // Agent performance
      query(
        `SELECT a.name, a.vehicle_number,
                COUNT(r.id) as total_routes,
                COUNT(CASE WHEN r.status = 'completed' THEN 1 END) as completed_routes,
                COALESCE(AVG(r.total_distance), 0) as avg_distance,
                COALESCE(SUM(o.pickup_margin), 0) as total_earnings
         FROM routes r
         JOIN agents a ON r.agent_id = a.id
         LEFT JOIN route_orders ro ON r.id = ro.route_id
         LEFT JOIN orders o ON ro.order_id = o.id
         WHERE ${whereConditions.join(' AND ')}
         GROUP BY a.id, a.name, a.vehicle_number
         ORDER BY completed_routes DESC
         LIMIT 10`,
        params
      )
    ]);

    res.json({
      success: true,
      data: {
        route_stats: routeStats.rows[0],
        efficiency_stats: efficiencyStats.rows[0],
        daily_trend: dailyTrend.rows,
        agent_performance: agentPerformance.rows
      }
    });

  } catch (error) {
    logger.error('Get route analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch route analytics'
    });
  }
});

// Calculate route optimization suggestions (admin only)
router.post('/suggestions', authenticate, authorize('admin'), async (req, res) => {
  try {
    const schema = Joi.object({
      route_date: Joi.date().required(),
      district: Joi.string().optional(),
      max_distance: Joi.number().positive().default(100), // km
      max_duration: Joi.number().positive().default(480) // minutes (8 hours)
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Get existing routes for the date
    const existingRoutes = await query(
      `SELECT r.*, COUNT(ro.id) as order_count
       FROM routes r
       LEFT JOIN route_orders ro ON r.id = ro.route_id
       WHERE r.route_date = $1
       GROUP BY r.id
       ORDER BY r.total_distance DESC`,
      [value.route_date]
    );

    // Analyze route efficiency
    const suggestions = [];

    for (const route of existingRoutes.rows) {
      if (route.total_distance > value.max_distance) {
        suggestions.push({
          type: 'distance_optimization',
          route_id: route.id,
          current_distance: route.total_distance,
          suggestion: 'Route exceeds maximum distance. Consider splitting into multiple routes.',
          priority: 'high'
        });
      }

      if (route.estimated_duration > value.max_duration) {
        suggestions.push({
          type: 'duration_optimization',
          route_id: route.id,
          current_duration: route.estimated_duration,
          suggestion: 'Route duration too long. Consider reducing order count or optimizing sequence.',
          priority: 'medium'
        });
      }

      if (route.order_count < 5) {
        suggestions.push({
          type: 'utilization_optimization',
          route_id: route.id,
          current_orders: route.order_count,
          suggestion: 'Route underutilized. Consider combining with nearby routes.',
          priority: 'low'
        });
      }
    }

    // Check for unassigned orders
    const unassignedOrders = await query(
      `SELECT COUNT(*) as count
       FROM orders o
       JOIN farmers f ON o.farmer_id = f.id
       LEFT JOIN route_orders ro ON o.id = ro.order_id
       WHERE o.status = 'confirmed' AND ro.id IS NULL
       ${value.district ? 'AND f.district = $2' : ''}`,
      value.district ? [value.route_date, value.district] : [value.route_date]
    );

    if (parseInt(unassignedOrders.rows[0].count) > 0) {
      suggestions.push({
        type: 'unassigned_orders',
        count: parseInt(unassignedOrders.rows[0].count),
        suggestion: `${unassignedOrders.rows[0].count} orders need to be assigned to routes.`,
        priority: 'high'
      });
    }

    res.json({
      success: true,
      data: {
        suggestions,
        total_routes: existingRoutes.rows.length,
        analysis_date: value.route_date
      }
    });

  } catch (error) {
    logger.error('Route suggestions error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate route suggestions'
    });
  }
});

module.exports = router;