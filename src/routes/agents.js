const express = require('express');
const Joi = require('joi');
const multer = require('multer');
const AWS = require('aws-sdk');
const { query, transaction } = require('../database/connection');
const { authenticate, authorize } = require('../middleware/auth');
const { sendNotification } = require('../services/communications');
const logger = require('../utils/logger');

const router = express.Router();

// Configure AWS S3
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

// Configure multer for proof photos
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Get agent dashboard
router.get('/dashboard', authenticate, authorize('agent'), async (req, res) => {
  try {
    const agentId = await query(
      'SELECT id FROM agents WHERE user_id = $1',
      [req.user.id]
    );

    if (agentId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent profile not found'
      });
    }

    const agentUUID = agentId.rows[0].id;

    // Get dashboard statistics
    const [
      todayRoutes,
      todayPickups,
      todayEarnings,
      totalPickups,
      agentRating,
      activeRoute,
      pendingPickups
    ] = await Promise.all([
      query(
        'SELECT COUNT(*) as count FROM routes WHERE agent_id = $1 AND route_date = CURRENT_DATE',
        [agentUUID]
      ),
      query(
        `SELECT COUNT(*) as count FROM route_orders ro
         JOIN routes r ON ro.route_id = r.id
         WHERE r.agent_id = $1 AND r.route_date = CURRENT_DATE AND ro.actual_pickup_time IS NOT NULL`,
        [agentUUID]
      ),
      query(
        'SELECT earnings_today FROM agents WHERE id = $1',
        [agentUUID]
      ),
      query(
        'SELECT total_pickups FROM agents WHERE id = $1',
        [agentUUID]
      ),
      query(
        'SELECT rating FROM agents WHERE id = $1',
        [agentUUID]
      ),
      query(
        `SELECT r.*, COUNT(ro.id) as total_orders,
                COUNT(CASE WHEN ro.actual_pickup_time IS NOT NULL THEN 1 END) as completed_pickups
         FROM routes r
         LEFT JOIN route_orders ro ON r.id = ro.route_id
         WHERE r.agent_id = $1 AND r.status = 'active'
         GROUP BY r.id
         ORDER BY r.created_at DESC
         LIMIT 1`,
        [agentUUID]
      ),
      query(
        `SELECT o.*, p.name as product_name, f.name as farmer_name, f.village,
                ro.pickup_eta, ro.sequence_number
         FROM orders o
         JOIN route_orders ro ON o.id = ro.order_id
         JOIN routes r ON ro.route_id = r.id
         JOIN product_listings pl ON o.product_listing_id = pl.id
         JOIN products p ON pl.product_id = p.id
         JOIN farmers f ON o.farmer_id = f.id
         WHERE r.agent_id = $1 AND r.route_date = CURRENT_DATE 
               AND ro.actual_pickup_time IS NULL AND o.status = 'confirmed'
         ORDER BY ro.sequence_number
         LIMIT 5`,
        [agentUUID]
      )
    ]);

    res.json({
      success: true,
      data: {
        statistics: {
          today_routes: parseInt(todayRoutes.rows[0].count),
          today_pickups: parseInt(todayPickups.rows[0].count),
          today_earnings: parseFloat(todayEarnings.rows[0]?.earnings_today || 0),
          total_pickups: parseInt(totalPickups.rows[0]?.total_pickups || 0),
          rating: parseFloat(agentRating.rows[0]?.rating || 5.0)
        },
        active_route: activeRoute.rows[0] || null,
        pending_pickups: pendingPickups.rows
      }
    });

  } catch (error) {
    logger.error('Agent dashboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard data'
    });
  }
});

// Get agent's routes
router.get('/routes', authenticate, authorize('agent'), async (req, res) => {
  try {
    const { status, date, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    const agentId = await query(
      'SELECT id FROM agents WHERE user_id = $1',
      [req.user.id]
    );

    if (agentId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent profile not found'
      });
    }

    const agentUUID = agentId.rows[0].id;

    let whereConditions = ['r.agent_id = $1'];
    let params = [agentUUID];
    let paramCount = 1;

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

    const routes = await query(
      `SELECT r.*, 
              COUNT(ro.id) as total_orders,
              COUNT(CASE WHEN ro.actual_pickup_time IS NOT NULL THEN 1 END) as completed_pickups,
              COUNT(CASE WHEN ro.actual_delivery_time IS NOT NULL THEN 1 END) as completed_deliveries,
              COALESCE(SUM(o.pickup_margin), 0) as total_earnings
       FROM routes r
       LEFT JOIN route_orders ro ON r.id = ro.route_id
       LEFT JOIN orders o ON ro.order_id = o.id
       WHERE ${whereConditions.join(' AND ')}
       GROUP BY r.id
       ORDER BY r.route_date DESC, r.created_at DESC
       LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      data: routes.rows
    });

  } catch (error) {
    logger.error('Get agent routes error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch routes'
    });
  }
});

// Get route details with orders
router.get('/routes/:routeId', authenticate, authorize('agent'), async (req, res) => {
  try {
    const { routeId } = req.params;

    const agentId = await query(
      'SELECT id FROM agents WHERE user_id = $1',
      [req.user.id]
    );

    if (agentId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent profile not found'
      });
    }

    const agentUUID = agentId.rows[0].id;

    // Get route details
    const route = await query(
      'SELECT * FROM routes WHERE id = $1 AND agent_id = $2',
      [routeId, agentUUID]
    );

    if (route.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Route not found'
      });
    }

    // Get route orders
    const orders = await query(
      `SELECT o.*, ro.sequence_number, ro.pickup_eta, ro.delivery_eta,
              ro.actual_pickup_time, ro.actual_delivery_time,
              p.name as product_name, p.unit,
              f.name as farmer_name, f.village as farmer_village, f.qr_code as farmer_qr,
              ST_X(o.pickup_location::geometry) as pickup_longitude,
              ST_Y(o.pickup_location::geometry) as pickup_latitude,
              v.business_name, v.address as vendor_address,
              ST_X(o.delivery_location::geometry) as delivery_longitude,
              ST_Y(o.delivery_location::geometry) as delivery_latitude
       FROM route_orders ro
       JOIN orders o ON ro.order_id = o.id
       JOIN product_listings pl ON o.product_listing_id = pl.id
       JOIN products p ON pl.product_id = p.id
       JOIN farmers f ON o.farmer_id = f.id
       JOIN vendors v ON o.vendor_id = v.id
       WHERE ro.route_id = $1
       ORDER BY ro.sequence_number`,
      [routeId]
    );

    res.json({
      success: true,
      data: {
        route: route.rows[0],
        orders: orders.rows
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

// Start route
router.post('/routes/:routeId/start', authenticate, authorize('agent'), async (req, res) => {
  try {
    const { routeId } = req.params;
    const { current_location } = req.body;

    const agentId = await query(
      'SELECT id FROM agents WHERE user_id = $1',
      [req.user.id]
    );

    if (agentId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent profile not found'
      });
    }

    const agentUUID = agentId.rows[0].id;

    const result = await transaction(async (client) => {
      // Update route status
      const routeUpdate = await client.query(
        'UPDATE routes SET status = $1 WHERE id = $2 AND agent_id = $3 AND status = $4 RETURNING *',
        ['active', routeId, agentUUID, 'planned']
      );

      if (routeUpdate.rows.length === 0) {
        throw new Error('Route not found or cannot be started');
      }

      // Update agent location and availability
      if (current_location) {
        await client.query(
          'UPDATE agents SET current_location = ST_SetSRID(ST_MakePoint($1, $2), 4326), is_available = false WHERE id = $3',
          [current_location.longitude, current_location.latitude, agentUUID]
        );
      }

      return routeUpdate.rows[0];
    });

    res.json({
      success: true,
      message: 'Route started successfully',
      data: result
    });

  } catch (error) {
    logger.error('Start route error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to start route'
    });
  }
});

// Scan QR code for pickup/delivery
router.post('/scan-qr', authenticate, authorize('agent'), upload.single('proof_photo'), async (req, res) => {
  try {
    const schema = Joi.object({
      qr_data: Joi.string().required(),
      action: Joi.string().valid('pickup', 'delivery').required(),
      location: Joi.object({
        latitude: Joi.number().required(),
        longitude: Joi.number().required()
      }).required(),
      notes: Joi.string().max(500).optional()
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const agentId = await query(
      'SELECT id FROM agents WHERE user_id = $1',
      [req.user.id]
    );

    if (agentId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent profile not found'
      });
    }

    const agentUUID = agentId.rows[0].id;

    // Parse QR data (format: "order:ORDER_ID" or "farmer:FARMER_ID")
    const [qrType, qrId] = value.qr_data.split(':');

    let orderId;
    if (qrType === 'order') {
      orderId = qrId;
    } else if (qrType === 'farmer') {
      // Find order by farmer QR
      const orderResult = await query(
        `SELECT o.id FROM orders o
         JOIN farmers f ON o.farmer_id = f.id
         JOIN route_orders ro ON o.id = ro.order_id
         JOIN routes r ON ro.route_id = r.id
         WHERE f.qr_code LIKE $1 AND r.agent_id = $2 AND r.status = 'active'
         ORDER BY ro.sequence_number
         LIMIT 1`,
        [`%${qrId}%`, agentUUID]
      );

      if (orderResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No active order found for this farmer'
        });
      }

      orderId = orderResult.rows[0].id;
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid QR code format'
      });
    }

    // Upload proof photo if provided
    let proofPhotoUrl = null;
    if (req.file) {
      const key = `proofs/${agentUUID}/${Date.now()}-${req.file.originalname}`;
      const uploadParams = {
        Bucket: process.env.AWS_S3_BUCKET,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
        ACL: 'public-read'
      };

      const uploadResult = await s3.upload(uploadParams).promise();
      proofPhotoUrl = uploadResult.Location;
    }

    const result = await transaction(async (client) => {
      // Verify order belongs to agent's active route
      const orderCheck = await client.query(
        `SELECT o.*, ro.sequence_number, ro.actual_pickup_time, ro.actual_delivery_time
         FROM orders o
         JOIN route_orders ro ON o.id = ro.order_id
         JOIN routes r ON ro.route_id = r.id
         WHERE o.id = $1 AND r.agent_id = $2 AND r.status = 'active'`,
        [orderId, agentUUID]
      );

      if (orderCheck.rows.length === 0) {
        throw new Error('Order not found in your active route');
      }

      const order = orderCheck.rows[0];

      if (value.action === 'pickup') {
        // Verify order is confirmed and not already picked
        if (order.status !== 'confirmed') {
          throw new Error('Order is not ready for pickup');
        }

        if (order.actual_pickup_time) {
          throw new Error('Order already picked up');
        }

        // Update order status and pickup time
        await client.query(
          'UPDATE orders SET status = $1 WHERE id = $2',
          ['picked', orderId]
        );

        await client.query(
          'UPDATE route_orders SET actual_pickup_time = CURRENT_TIMESTAMP WHERE order_id = $1',
          [orderId]
        );

        // Update agent earnings
        await client.query(
          'UPDATE agents SET earnings_today = earnings_today + $1, total_pickups = total_pickups + 1 WHERE id = $2',
          [order.pickup_margin, agentUUID]
        );

      } else if (value.action === 'delivery') {
        // Verify order is picked and not already delivered
        if (order.status !== 'picked' && order.status !== 'in_transit') {
          throw new Error('Order is not ready for delivery');
        }

        if (order.actual_delivery_time) {
          throw new Error('Order already delivered');
        }

        // Update order status and delivery time
        await client.query(
          'UPDATE orders SET status = $1 WHERE id = $2',
          ['delivered', orderId]
        );

        await client.query(
          'UPDATE route_orders SET actual_delivery_time = CURRENT_TIMESTAMP WHERE order_id = $1',
          [orderId]
        );

        // Create payment record for farmer
        await client.query(
          `INSERT INTO payments (order_id, farmer_id, amount, payment_method, status)
           VALUES ($1, $2, $3, 'upi', 'pending')`,
          [orderId, order.farmer_id, order.total_amount]
        );
      }

      // Update agent location
      await client.query(
        'UPDATE agents SET current_location = ST_SetSRID(ST_MakePoint($1, $2), 4326) WHERE id = $3',
        [value.location.longitude, value.location.latitude, agentUUID]
      );

      return order;
    });

    // Send notifications
    const notifications = [];
    
    if (value.action === 'pickup') {
      // Notify farmer and vendor
      notifications.push(
        sendNotification(
          (await query('SELECT user_id FROM farmers WHERE id = $1', [result.farmer_id])).rows[0].user_id,
          `आपका ऑर्डर #${result.order_number} पिक हो गया है।`,
          'order_picked'
        ),
        sendNotification(
          (await query('SELECT user_id FROM vendors WHERE id = $1', [result.vendor_id])).rows[0].user_id,
          `Order #${result.order_number} has been picked up and is on the way.`,
          'order_picked'
        )
      );
    } else if (value.action === 'delivery') {
      // Notify vendor and farmer
      notifications.push(
        sendNotification(
          (await query('SELECT user_id FROM vendors WHERE id = $1', [result.vendor_id])).rows[0].user_id,
          `Order #${result.order_number} delivered successfully. Please rate the farmer.`,
          'order_delivered'
        ),
        sendNotification(
          (await query('SELECT user_id FROM farmers WHERE id = $1', [result.farmer_id])).rows[0].user_id,
          `आपका ऑर्डर #${result.order_number} डिलीवर हो गया है। पेमेंट जल्द ही मिलेगा।`,
          'order_delivered'
        )
      );
    }

    await Promise.allSettled(notifications);

    res.json({
      success: true,
      message: `${value.action === 'pickup' ? 'Pickup' : 'Delivery'} recorded successfully`,
      data: {
        order_id: orderId,
        action: value.action,
        proof_photo: proofPhotoUrl,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Scan QR error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to process QR scan'
    });
  }
});

// Update agent location
router.post('/location', authenticate, authorize('agent'), async (req, res) => {
  try {
    const schema = Joi.object({
      latitude: Joi.number().required(),
      longitude: Joi.number().required()
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const agentId = await query(
      'SELECT id FROM agents WHERE user_id = $1',
      [req.user.id]
    );

    if (agentId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent profile not found'
      });
    }

    const agentUUID = agentId.rows[0].id;

    await query(
      'UPDATE agents SET current_location = ST_SetSRID(ST_MakePoint($1, $2), 4326) WHERE id = $3',
      [value.longitude, value.latitude, agentUUID]
    );

    res.json({
      success: true,
      message: 'Location updated successfully'
    });

  } catch (error) {
    logger.error('Update location error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update location'
    });
  }
});

// Complete route
router.post('/routes/:routeId/complete', authenticate, authorize('agent'), async (req, res) => {
  try {
    const { routeId } = req.params;

    const agentId = await query(
      'SELECT id FROM agents WHERE user_id = $1',
      [req.user.id]
    );

    if (agentId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent profile not found'
      });
    }

    const agentUUID = agentId.rows[0].id;

    const result = await transaction(async (client) => {
      // Check if all orders in route are completed
      const incompleteOrders = await client.query(
        `SELECT COUNT(*) as count FROM route_orders ro
         JOIN orders o ON ro.order_id = o.id
         WHERE ro.route_id = $1 AND o.status NOT IN ('delivered', 'cancelled')`,
        [routeId]
      );

      if (parseInt(incompleteOrders.rows[0].count) > 0) {
        throw new Error('Cannot complete route. Some orders are still pending.');
      }

      // Update route status
      const routeUpdate = await client.query(
        'UPDATE routes SET status = $1 WHERE id = $2 AND agent_id = $3 RETURNING *',
        ['completed', routeId, agentUUID]
      );

      if (routeUpdate.rows.length === 0) {
        throw new Error('Route not found');
      }

      // Update agent availability
      await client.query(
        'UPDATE agents SET is_available = true WHERE id = $1',
        [agentUUID]
      );

      return routeUpdate.rows[0];
    });

    res.json({
      success: true,
      message: 'Route completed successfully',
      data: result
    });

  } catch (error) {
    logger.error('Complete route error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to complete route'
    });
  }
});

// Get agent earnings
router.get('/earnings', authenticate, authorize('agent'), async (req, res) => {
  try {
    const { period = '30', start_date, end_date } = req.query;

    const agentId = await query(
      'SELECT id FROM agents WHERE user_id = $1',
      [req.user.id]
    );

    if (agentId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent profile not found'
      });
    }

    const agentUUID = agentId.rows[0].id;

    let dateFilter = '';
    let params = [agentUUID];

    if (start_date && end_date) {
      dateFilter = 'AND r.route_date BETWEEN $2 AND $3';
      params.push(start_date, end_date);
    } else {
      dateFilter = 'AND r.route_date >= CURRENT_DATE - INTERVAL $2 DAY';
      params.push(`${period} days`);
    }

    const [summary, dailyEarnings, routeBreakdown] = await Promise.all([
      // Earnings summary
      query(
        `SELECT 
           COUNT(DISTINCT r.id) as total_routes,
           COUNT(ro.id) as total_pickups,
           COALESCE(SUM(o.pickup_margin), 0) as total_earnings,
           COALESCE(AVG(o.pickup_margin), 0) as avg_earnings_per_pickup
         FROM routes r
         LEFT JOIN route_orders ro ON r.id = ro.route_id AND ro.actual_pickup_time IS NOT NULL
         LEFT JOIN orders o ON ro.order_id = o.id
         WHERE r.agent_id = $1 ${dateFilter}`,
        params
      ),

      // Daily earnings
      query(
        `SELECT r.route_date,
                COUNT(ro.id) as pickups,
                COALESCE(SUM(o.pickup_margin), 0) as daily_earnings
         FROM routes r
         LEFT JOIN route_orders ro ON r.id = ro.route_id AND ro.actual_pickup_time IS NOT NULL
         LEFT JOIN orders o ON ro.order_id = o.id
         WHERE r.agent_id = $1 ${dateFilter}
         GROUP BY r.route_date
         ORDER BY r.route_date DESC`,
        params
      ),

      // Route-wise breakdown
      query(
        `SELECT r.route_name, r.route_date, r.status,
                COUNT(ro.id) as total_orders,
                COUNT(CASE WHEN ro.actual_pickup_time IS NOT NULL THEN 1 END) as completed_pickups,
                COALESCE(SUM(o.pickup_margin), 0) as route_earnings
         FROM routes r
         LEFT JOIN route_orders ro ON r.id = ro.route_id
         LEFT JOIN orders o ON ro.order_id = o.id
         WHERE r.agent_id = $1 ${dateFilter}
         GROUP BY r.id, r.route_name, r.route_date, r.status
         ORDER BY r.route_date DESC`,
        params
      )
    ]);

    res.json({
      success: true,
      data: {
        summary: summary.rows[0],
        daily_earnings: dailyEarnings.rows,
        route_breakdown: routeBreakdown.rows
      }
    });

  } catch (error) {
    logger.error('Get agent earnings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch earnings'
    });
  }
});

// Get agent performance metrics
router.get('/performance', authenticate, authorize('agent'), async (req, res) => {
  try {
    const agentId = await query(
      'SELECT id FROM agents WHERE user_id = $1',
      [req.user.id]
    );

    if (agentId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent profile not found'
      });
    }

    const agentUUID = agentId.rows[0].id;

    const [performance, ratings] = await Promise.all([
      // Performance metrics
      query(
        `SELECT 
           COUNT(DISTINCT r.id) as total_routes_completed,
           COUNT(ro.id) as total_orders_handled,
           COUNT(CASE WHEN ro.actual_pickup_time IS NOT NULL THEN 1 END) as successful_pickups,
           COUNT(CASE WHEN ro.actual_delivery_time IS NOT NULL THEN 1 END) as successful_deliveries,
           COALESCE(AVG(EXTRACT(EPOCH FROM (ro.actual_pickup_time - ro.pickup_eta))/60), 0) as avg_pickup_delay_minutes,
           COALESCE(AVG(EXTRACT(EPOCH FROM (ro.actual_delivery_time - ro.delivery_eta))/60), 0) as avg_delivery_delay_minutes
         FROM routes r
         LEFT JOIN route_orders ro ON r.id = ro.route_id
         WHERE r.agent_id = $1 AND r.status = 'completed'`,
        [agentUUID]
      ),

      // Recent ratings
      query(
        `SELECT r.rating, r.comments, r.created_at,
                o.order_number,
                CASE 
                  WHEN u.user_type = 'farmer' THEN f.name
                  WHEN u.user_type = 'vendor' THEN v.business_name
                END as rated_by_name
         FROM ratings r
         JOIN orders o ON r.order_id = o.id
         JOIN route_orders ro ON o.id = ro.order_id
         JOIN routes rt ON ro.route_id = rt.id
         JOIN users u ON r.rated_by = u.id
         LEFT JOIN farmers f ON u.id = f.user_id
         LEFT JOIN vendors v ON u.id = v.user_id
         WHERE rt.agent_id = $1
         ORDER BY r.created_at DESC
         LIMIT 10`,
        [agentUUID]
      )
    ]);

    res.json({
      success: true,
      data: {
        performance: performance.rows[0],
        recent_ratings: ratings.rows
      }
    });

  } catch (error) {
    logger.error('Get agent performance error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch performance metrics'
    });
  }
});

module.exports = router;