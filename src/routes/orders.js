const express = require('express');
const Joi = require('joi');
const { query, transaction } = require('../database/connection');
const { authenticate, authorize } = require('../middleware/auth');
const { sendNotification } = require('../services/communications');
const logger = require('../utils/logger');

const router = express.Router();

// Get order details (accessible to all user types)
router.get('/:orderId', authenticate, async (req, res) => {
  try {
    const { orderId } = req.params;

    // Build query based on user type
    let whereClause = 'WHERE o.id = $1';
    let params = [orderId];

    // Add user-specific filters
    if (req.user.user_type === 'farmer') {
      whereClause += ' AND f.user_id = $2';
      params.push(req.user.id);
    } else if (req.user.user_type === 'vendor') {
      whereClause += ' AND v.user_id = $2';
      params.push(req.user.id);
    } else if (req.user.user_type === 'agent') {
      whereClause += ' AND a.user_id = $2';
      params.push(req.user.id);
    }

    const order = await query(
      `SELECT o.*, 
              p.name as product_name, p.unit, p.category,
              f.name as farmer_name, f.village as farmer_village, f.district as farmer_district,
              f.hygiene_rating, f.hygiene_badge, f.phone_number as farmer_phone,
              v.business_name, v.owner_name as vendor_name, v.phone_number as vendor_phone,
              v.address as vendor_address,
              pl.quality_grade, pl.harvest_date, pl.images as product_images,
              a.name as agent_name, a.vehicle_number, a.phone_number as agent_phone,
              rt.route_name, rt.estimated_duration, rt.status as route_status,
              ro.pickup_eta, ro.delivery_eta, ro.actual_pickup_time, ro.actual_delivery_time,
              ro.sequence_number,
              ST_X(o.pickup_location::geometry) as pickup_longitude,
              ST_Y(o.pickup_location::geometry) as pickup_latitude,
              ST_X(o.delivery_location::geometry) as delivery_longitude,
              ST_Y(o.delivery_location::geometry) as delivery_latitude,
              pay.status as payment_status, pay.transaction_id,
              r.rating as order_rating, r.comments as order_comments
       FROM orders o
       JOIN product_listings pl ON o.product_listing_id = pl.id
       JOIN products p ON pl.product_id = p.id
       JOIN farmers f ON o.farmer_id = f.id
       JOIN users uf ON f.user_id = uf.id
       JOIN vendors v ON o.vendor_id = v.id
       JOIN users uv ON v.user_id = uv.id
       LEFT JOIN route_orders ro ON o.id = ro.order_id
       LEFT JOIN routes rt ON ro.route_id = rt.id
       LEFT JOIN agents a ON rt.agent_id = a.id
       LEFT JOIN users ua ON a.user_id = ua.id
       LEFT JOIN payments pay ON o.id = pay.order_id
       LEFT JOIN ratings r ON o.id = r.order_id
       ${whereClause}`,
      params
    );

    if (order.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    res.json({
      success: true,
      data: order.rows[0]
    });

  } catch (error) {
    logger.error('Get order details error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch order details'
    });
  }
});

// Update order status (admin and agents only)
router.put('/:orderId/status', authenticate, authorize('admin', 'agent'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const schema = Joi.object({
      status: Joi.string().valid('placed', 'confirmed', 'picked', 'in_transit', 'delivered', 'cancelled', 'disputed').required(),
      notes: Joi.string().max(500).optional(),
      location: Joi.object({
        latitude: Joi.number().optional(),
        longitude: Joi.number().optional()
      }).optional()
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const result = await transaction(async (client) => {
      // Get current order details
      const currentOrder = await client.query(
        'SELECT * FROM orders WHERE id = $1',
        [orderId]
      );

      if (currentOrder.rows.length === 0) {
        throw new Error('Order not found');
      }

      const order = currentOrder.rows[0];

      // Update order status
      const updatedOrder = await client.query(
        'UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
        [value.status, orderId]
      );

      // Update route_orders with actual times based on status
      if (value.status === 'picked') {
        await client.query(
          'UPDATE route_orders SET actual_pickup_time = CURRENT_TIMESTAMP WHERE order_id = $1',
          [orderId]
        );
      } else if (value.status === 'delivered') {
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

        // Update farmer statistics
        await client.query(
          'UPDATE farmers SET total_deliveries = total_deliveries + 1 WHERE id = $1',
          [order.farmer_id]
        );
      }

      return updatedOrder.rows[0];
    });

    // Send notifications based on status change
    const notifications = [];
    
    if (value.status === 'picked') {
      // Notify vendor and farmer
      notifications.push(
        sendNotification(
          (await query('SELECT user_id FROM vendors WHERE id = $1', [result.vendor_id])).rows[0].user_id,
          `Order #${result.order_number} has been picked up and is on the way.`,
          'order_picked'
        ),
        sendNotification(
          (await query('SELECT user_id FROM farmers WHERE id = $1', [result.farmer_id])).rows[0].user_id,
          `आपका ऑर्डर #${result.order_number} पिक हो गया है।`,
          'order_picked'
        )
      );
    } else if (value.status === 'delivered') {
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

    // Execute all notifications
    await Promise.allSettled(notifications);

    res.json({
      success: true,
      message: 'Order status updated successfully',
      data: result
    });

  } catch (error) {
    logger.error('Update order status error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update order status'
    });
  }
});

// Get order tracking information
router.get('/:orderId/tracking', authenticate, async (req, res) => {
  try {
    const { orderId } = req.params;

    // Verify user has access to this order
    const accessCheck = await query(
      `SELECT o.id FROM orders o
       LEFT JOIN farmers f ON o.farmer_id = f.id
       LEFT JOIN vendors v ON o.vendor_id = v.id
       LEFT JOIN route_orders ro ON o.id = ro.order_id
       LEFT JOIN routes rt ON ro.route_id = rt.id
       LEFT JOIN agents a ON rt.agent_id = a.id
       WHERE o.id = $1 AND (
         f.user_id = $2 OR v.user_id = $2 OR a.user_id = $2 OR $3 = 'admin'
       )`,
      [orderId, req.user.id, req.user.user_type]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Order not found or access denied'
      });
    }

    // Get detailed tracking information
    const tracking = await query(
      `SELECT o.id, o.order_number, o.status, o.created_at,
              o.pickup_time, o.delivery_time,
              ST_X(o.pickup_location::geometry) as pickup_longitude,
              ST_Y(o.pickup_location::geometry) as pickup_latitude,
              ST_X(o.delivery_location::geometry) as delivery_longitude,
              ST_Y(o.delivery_location::geometry) as delivery_latitude,
              f.name as farmer_name, f.village,
              v.business_name,
              a.name as agent_name, a.vehicle_number,
              ST_X(a.current_location::geometry) as agent_longitude,
              ST_Y(a.current_location::geometry) as agent_latitude,
              rt.route_name, rt.status as route_status,
              ro.pickup_eta, ro.delivery_eta, 
              ro.actual_pickup_time, ro.actual_delivery_time,
              ro.sequence_number
       FROM orders o
       JOIN farmers f ON o.farmer_id = f.id
       JOIN vendors v ON o.vendor_id = v.id
       LEFT JOIN route_orders ro ON o.id = ro.order_id
       LEFT JOIN routes rt ON ro.route_id = rt.id
       LEFT JOIN agents a ON rt.agent_id = a.id
       WHERE o.id = $1`,
      [orderId]
    );

    // Get status history (you might want to create a separate status_history table)
    const statusHistory = [
      { status: 'placed', timestamp: tracking.rows[0].created_at, description: 'Order placed by vendor' },
    ];

    if (tracking.rows[0].status !== 'placed') {
      statusHistory.push({ status: 'confirmed', timestamp: tracking.rows[0].created_at, description: 'Order confirmed by farmer' });
    }

    if (tracking.rows[0].actual_pickup_time) {
      statusHistory.push({ 
        status: 'picked', 
        timestamp: tracking.rows[0].actual_pickup_time, 
        description: 'Product picked up from farmer' 
      });
    }

    if (tracking.rows[0].actual_delivery_time) {
      statusHistory.push({ 
        status: 'delivered', 
        timestamp: tracking.rows[0].actual_delivery_time, 
        description: 'Order delivered to vendor' 
      });
    }

    res.json({
      success: true,
      data: {
        order: tracking.rows[0],
        status_history: statusHistory,
        estimated_delivery: tracking.rows[0].delivery_eta
      }
    });

  } catch (error) {
    logger.error('Get order tracking error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tracking information'
    });
  }
});

// Create dispute for order
router.post('/:orderId/dispute', authenticate, async (req, res) => {
  try {
    const { orderId } = req.params;
    const schema = Joi.object({
      dispute_type: Joi.string().required(),
      description: Joi.string().max(1000).required(),
      evidence_images: Joi.array().items(Joi.string()).optional()
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Verify user has access to this order
    const orderCheck = await query(
      `SELECT o.id, o.status FROM orders o
       LEFT JOIN farmers f ON o.farmer_id = f.id
       LEFT JOIN vendors v ON o.vendor_id = v.id
       WHERE o.id = $1 AND (f.user_id = $2 OR v.user_id = $2)`,
      [orderId, req.user.id]
    );

    if (orderCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Order not found or access denied'
      });
    }

    const dispute = await transaction(async (client) => {
      // Create dispute
      const disputeInsert = await client.query(
        `INSERT INTO disputes (order_id, raised_by, dispute_type, description, evidence_images)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [orderId, req.user.id, value.dispute_type, value.description, JSON.stringify(value.evidence_images || [])]
      );

      // Update order status to disputed
      await client.query(
        'UPDATE orders SET status = $1 WHERE id = $2',
        ['disputed', orderId]
      );

      return disputeInsert.rows[0];
    });

    // Notify admin about the dispute
    const adminUsers = await query(
      'SELECT id FROM users WHERE user_type = $1',
      ['admin']
    );

    const notifications = adminUsers.rows.map(admin => 
      sendNotification(
        admin.id,
        `New dispute raised for Order #${orderCheck.rows[0].order_number}: ${value.dispute_type}`,
        'dispute_raised',
        'urgent'
      )
    );

    await Promise.allSettled(notifications);

    res.status(201).json({
      success: true,
      message: 'Dispute created successfully',
      data: dispute
    });

  } catch (error) {
    logger.error('Create dispute error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create dispute'
    });
  }
});

// Get order disputes (admin only)
router.get('/:orderId/disputes', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { orderId } = req.params;

    const disputes = await query(
      `SELECT d.*, 
              u.phone_number as raised_by_phone,
              CASE 
                WHEN u.user_type = 'farmer' THEN f.name
                WHEN u.user_type = 'vendor' THEN v.business_name
                ELSE u.phone_number
              END as raised_by_name,
              ru.phone_number as resolved_by_phone
       FROM disputes d
       JOIN users u ON d.raised_by = u.id
       LEFT JOIN farmers f ON u.id = f.user_id
       LEFT JOIN vendors v ON u.id = v.user_id
       LEFT JOIN users ru ON d.resolved_by = ru.id
       WHERE d.order_id = $1
       ORDER BY d.created_at DESC`,
      [orderId]
    );

    res.json({
      success: true,
      data: disputes.rows
    });

  } catch (error) {
    logger.error('Get order disputes error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch disputes'
    });
  }
});

// Resolve dispute (admin only)
router.put('/disputes/:disputeId/resolve', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { disputeId } = req.params;
    const schema = Joi.object({
      resolution: Joi.string().max(1000).required(),
      new_order_status: Joi.string().valid('confirmed', 'picked', 'in_transit', 'delivered', 'cancelled').optional()
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const result = await transaction(async (client) => {
      // Update dispute
      const disputeUpdate = await client.query(
        'UPDATE disputes SET status = $1, resolution = $2, resolved_by = $3, resolved_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
        ['resolved', value.resolution, req.user.id, disputeId]
      );

      if (disputeUpdate.rows.length === 0) {
        throw new Error('Dispute not found');
      }

      const dispute = disputeUpdate.rows[0];

      // Update order status if provided
      if (value.new_order_status) {
        await client.query(
          'UPDATE orders SET status = $1 WHERE id = $2',
          [value.new_order_status, dispute.order_id]
        );
      }

      return dispute;
    });

    // Notify the user who raised the dispute
    await sendNotification(
      result.raised_by,
      `Your dispute has been resolved: ${value.resolution}`,
      'dispute_resolved'
    );

    res.json({
      success: true,
      message: 'Dispute resolved successfully',
      data: result
    });

  } catch (error) {
    logger.error('Resolve dispute error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to resolve dispute'
    });
  }
});

// Get order analytics (admin only)
router.get('/analytics/summary', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { period = '30', status } = req.query;

    let statusFilter = '';
    let params = [`${period} days`];

    if (status) {
      statusFilter = 'AND status = $2';
      params.push(status);
    }

    const analytics = await query(
      `SELECT 
         COUNT(*) as total_orders,
         COUNT(CASE WHEN status = 'delivered' THEN 1 END) as completed_orders,
         COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled_orders,
         COUNT(CASE WHEN status = 'disputed' THEN 1 END) as disputed_orders,
         COALESCE(SUM(total_amount), 0) as total_value,
         COALESCE(SUM(delivery_fee), 0) as total_delivery_fees,
         COALESCE(AVG(total_amount), 0) as avg_order_value,
         COALESCE(AVG(EXTRACT(EPOCH FROM (delivery_time - created_at))/3600), 0) as avg_delivery_hours
       FROM orders 
       WHERE created_at >= CURRENT_DATE - INTERVAL $1 ${statusFilter}`,
      params
    );

    // Get daily order trend
    const dailyTrend = await query(
      `SELECT DATE(created_at) as order_date,
              COUNT(*) as order_count,
              COALESCE(SUM(total_amount), 0) as daily_value
       FROM orders 
       WHERE created_at >= CURRENT_DATE - INTERVAL $1
       GROUP BY DATE(created_at)
       ORDER BY order_date`,
      [`${period} days`]
    );

    // Get top products
    const topProducts = await query(
      `SELECT p.name, p.category,
              COUNT(*) as order_count,
              COALESCE(SUM(o.quantity), 0) as total_quantity,
              COALESCE(SUM(o.total_amount), 0) as total_value
       FROM orders o
       JOIN product_listings pl ON o.product_listing_id = pl.id
       JOIN products p ON pl.product_id = p.id
       WHERE o.created_at >= CURRENT_DATE - INTERVAL $1
       GROUP BY p.id, p.name, p.category
       ORDER BY total_value DESC
       LIMIT 10`,
      [`${period} days`]
    );

    res.json({
      success: true,
      data: {
        summary: analytics.rows[0],
        daily_trend: dailyTrend.rows,
        top_products: topProducts.rows
      }
    });

  } catch (error) {
    logger.error('Get order analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch order analytics'
    });
  }
});

module.exports = router;