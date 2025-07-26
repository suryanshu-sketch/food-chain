const express = require('express');
const Joi = require('joi');
const { query, transaction } = require('../database/connection');
const { authenticate, authorize } = require('../middleware/auth');
const { sendNotification, sendBulkNotifications } = require('../services/communications');
const logger = require('../utils/logger');

const router = express.Router();

// Get admin dashboard with system overview
router.get('/dashboard', authenticate, authorize('admin'), async (req, res) => {
  try {
    const [
      userStats,
      orderStats,
      revenueStats,
      systemHealth,
      recentActivity
    ] = await Promise.all([
      // User statistics
      query(`
        SELECT 
          COUNT(*) as total_users,
          COUNT(CASE WHEN user_type = 'farmer' THEN 1 END) as farmers,
          COUNT(CASE WHEN user_type = 'vendor' THEN 1 END) as vendors,
          COUNT(CASE WHEN user_type = 'agent' THEN 1 END) as agents,
          COUNT(CASE WHEN is_active = true THEN 1 END) as active_users,
          COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as new_users_week
        FROM users
      `),

      // Order statistics
      query(`
        SELECT 
          COUNT(*) as total_orders,
          COUNT(CASE WHEN status = 'delivered' THEN 1 END) as completed_orders,
          COUNT(CASE WHEN status IN ('placed', 'confirmed', 'picked', 'in_transit') THEN 1 END) as active_orders,
          COUNT(CASE WHEN status = 'disputed' THEN 1 END) as disputed_orders,
          COUNT(CASE WHEN created_at >= CURRENT_DATE THEN 1 END) as today_orders
        FROM orders
      `),

      // Revenue statistics
      query(`
        SELECT 
          COALESCE(SUM(total_amount + delivery_fee), 0) as total_revenue,
          COALESCE(SUM(delivery_fee), 0) as platform_revenue,
          COALESCE(SUM(pickup_margin), 0) as agent_revenue,
          COALESCE(SUM(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '30 days' THEN total_amount + delivery_fee ELSE 0 END), 0) as monthly_revenue
        FROM orders 
        WHERE status = 'delivered'
      `),

      // System health metrics
      query(`
        SELECT 
          COUNT(CASE WHEN f.hygiene_badge = 'red' THEN 1 END) as suspended_farmers,
          COUNT(CASE WHEN a.is_available = false THEN 1 END) as busy_agents,
          COUNT(CASE WHEN d.status = 'open' THEN 1 END) as open_disputes,
          COUNT(CASE WHEN r.status = 'active' THEN 1 END) as active_routes
        FROM farmers f
        CROSS JOIN agents a
        CROSS JOIN disputes d
        CROSS JOIN routes r
      `),

      // Recent activity
      query(`
        SELECT 
          'order' as type, 
          o.order_number as reference,
          o.status as status,
          o.created_at as timestamp,
          f.name as farmer_name,
          v.business_name as vendor_name
        FROM orders o
        JOIN farmers f ON o.farmer_id = f.id
        JOIN vendors v ON o.vendor_id = v.id
        WHERE o.created_at >= CURRENT_DATE - INTERVAL '24 hours'
        UNION ALL
        SELECT 
          'dispute' as type,
          CAST(d.id as TEXT) as reference,
          d.status as status,
          d.created_at as timestamp,
          '' as farmer_name,
          '' as vendor_name
        FROM disputes d
        WHERE d.created_at >= CURRENT_DATE - INTERVAL '24 hours'
        ORDER BY timestamp DESC
        LIMIT 20
      `)
    ]);

    res.json({
      success: true,
      data: {
        user_stats: userStats.rows[0],
        order_stats: orderStats.rows[0],
        revenue_stats: revenueStats.rows[0],
        system_health: systemHealth.rows[0],
        recent_activity: recentActivity.rows
      }
    });

  } catch (error) {
    logger.error('Admin dashboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard data'
    });
  }
});

// Get all users with filters
router.get('/users', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { 
      user_type, 
      is_active, 
      district, 
      state,
      search,
      page = 1, 
      limit = 20 
    } = req.query;
    
    const offset = (page - 1) * limit;

    let whereConditions = [];
    let params = [];
    let paramCount = 0;

    if (user_type) {
      paramCount++;
      whereConditions.push(`u.user_type = $${paramCount}`);
      params.push(user_type);
    }

    if (is_active !== undefined) {
      paramCount++;
      whereConditions.push(`u.is_active = $${paramCount}`);
      params.push(is_active === 'true');
    }

    if (district) {
      paramCount++;
      whereConditions.push(`(f.district = $${paramCount} OR v.city = $${paramCount})`);
      params.push(district);
    }

    if (state) {
      paramCount++;
      whereConditions.push(`(f.state = $${paramCount} OR v.state = $${paramCount})`);
      params.push(state);
    }

    if (search) {
      paramCount++;
      whereConditions.push(`(
        f.name ILIKE $${paramCount} OR 
        v.business_name ILIKE $${paramCount} OR 
        a.name ILIKE $${paramCount} OR
        u.phone_number ILIKE $${paramCount}
      )`);
      params.push(`%${search}%`);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const users = await query(`
      SELECT u.id, u.phone_number, u.user_type, u.is_active, u.created_at,
             COALESCE(f.name, v.business_name, a.name) as name,
             COALESCE(f.village, v.city, '') as location,
             COALESCE(f.district, v.city, '') as district,
             COALESCE(f.state, v.state, '') as state,
             f.hygiene_rating, f.hygiene_badge, f.total_deliveries,
             v.subscription_type, v.is_verified as vendor_verified,
             a.rating as agent_rating, a.total_pickups, a.is_available
      FROM users u
      LEFT JOIN farmers f ON u.id = f.user_id
      LEFT JOIN vendors v ON u.id = v.user_id  
      LEFT JOIN agents a ON u.id = a.user_id
      ${whereClause}
      ORDER BY u.created_at DESC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `, [...params, limit, offset]);

    // Get total count
    const totalResult = await query(`
      SELECT COUNT(*) as total FROM users u
      LEFT JOIN farmers f ON u.id = f.user_id
      LEFT JOIN vendors v ON u.id = v.user_id  
      LEFT JOIN agents a ON u.id = a.user_id
      ${whereClause}
    `, params);

    res.json({
      success: true,
      data: {
        users: users.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(totalResult.rows[0].total),
          pages: Math.ceil(totalResult.rows[0].total / limit)
        }
      }
    });

  } catch (error) {
    logger.error('Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users'
    });
  }
});

// Update user status (activate/deactivate)
router.put('/users/:userId/status', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const schema = Joi.object({
      is_active: Joi.boolean().required(),
      reason: Joi.string().max(500).optional()
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const result = await query(
      'UPDATE users SET is_active = $1 WHERE id = $2 RETURNING *',
      [value.is_active, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Send notification to user
    const statusMessage = value.is_active ? 'activated' : 'suspended';
    await sendNotification(
      userId,
      `Your account has been ${statusMessage}. ${value.reason ? `Reason: ${value.reason}` : ''}`,
      'account_status_changed',
      'urgent'
    );

    res.json({
      success: true,
      message: `User ${statusMessage} successfully`,
      data: result.rows[0]
    });

  } catch (error) {
    logger.error('Update user status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user status'
    });
  }
});

// Get system analytics
router.get('/analytics', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { period = '30' } = req.query;

    const [
      growthMetrics,
      transactionMetrics,
      performanceMetrics,
      geographicMetrics
    ] = await Promise.all([
      // Growth metrics
      query(`
        SELECT 
          DATE(created_at) as date,
          COUNT(*) as new_users,
          COUNT(CASE WHEN user_type = 'farmer' THEN 1 END) as new_farmers,
          COUNT(CASE WHEN user_type = 'vendor' THEN 1 END) as new_vendors
        FROM users 
        WHERE created_at >= CURRENT_DATE - INTERVAL '${period} days'
        GROUP BY DATE(created_at)
        ORDER BY date
      `),

      // Transaction metrics
      query(`
        SELECT 
          DATE(created_at) as date,
          COUNT(*) as daily_orders,
          COUNT(CASE WHEN status = 'delivered' THEN 1 END) as completed_orders,
          COALESCE(SUM(total_amount + delivery_fee), 0) as daily_revenue
        FROM orders 
        WHERE created_at >= CURRENT_DATE - INTERVAL '${period} days'
        GROUP BY DATE(created_at)
        ORDER BY date
      `),

      // Performance metrics
      query(`
        SELECT 
          COALESCE(AVG(EXTRACT(EPOCH FROM (delivery_time - created_at))/3600), 0) as avg_delivery_hours,
          COUNT(CASE WHEN status = 'delivered' THEN 1 END) * 100.0 / COUNT(*) as completion_rate,
          COUNT(CASE WHEN status = 'disputed' THEN 1 END) * 100.0 / COUNT(*) as dispute_rate,
          COALESCE(AVG(r.rating), 0) as avg_rating
        FROM orders o
        LEFT JOIN ratings r ON o.id = r.order_id
        WHERE o.created_at >= CURRENT_DATE - INTERVAL '${period} days'
      `),

      // Geographic distribution
      query(`
        SELECT 
          f.state,
          f.district,
          COUNT(DISTINCT f.id) as farmer_count,
          COUNT(DISTINCT o.id) as order_count,
          COALESCE(SUM(o.total_amount), 0) as total_value
        FROM farmers f
        LEFT JOIN orders o ON f.id = o.farmer_id AND o.created_at >= CURRENT_DATE - INTERVAL '${period} days'
        GROUP BY f.state, f.district
        ORDER BY order_count DESC
        LIMIT 20
      `)
    ]);

    res.json({
      success: true,
      data: {
        growth_metrics: growthMetrics.rows,
        transaction_metrics: transactionMetrics.rows,
        performance_metrics: performanceMetrics.rows[0],
        geographic_metrics: geographicMetrics.rows
      }
    });

  } catch (error) {
    logger.error('Get analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch analytics'
    });
  }
});

// Get all disputes
router.get('/disputes', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { status, type, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let whereConditions = [];
    let params = [];
    let paramCount = 0;

    if (status) {
      paramCount++;
      whereConditions.push(`d.status = $${paramCount}`);
      params.push(status);
    }

    if (type) {
      paramCount++;
      whereConditions.push(`d.dispute_type = $${paramCount}`);
      params.push(type);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const disputes = await query(`
      SELECT d.*, o.order_number,
             u1.phone_number as raised_by_phone,
             CASE 
               WHEN u1.user_type = 'farmer' THEN f1.name
               WHEN u1.user_type = 'vendor' THEN v1.business_name
               ELSE u1.phone_number
             END as raised_by_name,
             u1.user_type as raised_by_type,
             u2.phone_number as resolved_by_phone
      FROM disputes d
      JOIN orders o ON d.order_id = o.id
      JOIN users u1 ON d.raised_by = u1.id
      LEFT JOIN farmers f1 ON u1.id = f1.user_id
      LEFT JOIN vendors v1 ON u1.id = v1.user_id
      LEFT JOIN users u2 ON d.resolved_by = u2.id
      ${whereClause}
      ORDER BY d.created_at DESC
      LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
    `, [...params, limit, offset]);

    res.json({
      success: true,
      data: disputes.rows
    });

  } catch (error) {
    logger.error('Get disputes error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch disputes'
    });
  }
});

// Verify farmer/vendor
router.put('/verify/:userType/:userId', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { userType, userId } = req.params;
    const { verified, notes } = req.body;

    if (!['farmer', 'vendor', 'agent'].includes(userType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user type'
      });
    }

    let tableName;
    let userIdColumn;

    switch (userType) {
      case 'farmer':
        tableName = 'farmers';
        userIdColumn = 'user_id';
        break;
      case 'vendor':
        tableName = 'vendors';
        userIdColumn = 'user_id';
        break;
      case 'agent':
        tableName = 'agents';
        userIdColumn = 'user_id';
        break;
    }

    const result = await query(
      `UPDATE ${tableName} SET is_verified = $1 WHERE ${userIdColumn} = $2 RETURNING *`,
      [verified, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `${userType} not found`
      });
    }

    // Send notification
    const statusMessage = verified ? 'verified' : 'unverified';
    await sendNotification(
      userId,
      `Your account has been ${statusMessage}. ${notes ? `Notes: ${notes}` : ''}`,
      'verification_status_changed'
    );

    res.json({
      success: true,
      message: `${userType} ${statusMessage} successfully`,
      data: result.rows[0]
    });

  } catch (error) {
    logger.error('Verify user error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify user'
    });
  }
});

// Bulk operations
router.post('/bulk-operations', authenticate, authorize('admin'), async (req, res) => {
  try {
    const schema = Joi.object({
      operation: Joi.string().valid('activate', 'deactivate', 'notify', 'verify').required(),
      user_ids: Joi.array().items(Joi.string().uuid()).min(1).required(),
      data: Joi.object().optional()
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const results = [];

    switch (value.operation) {
      case 'activate':
      case 'deactivate':
        const isActive = value.operation === 'activate';
        for (const userId of value.user_ids) {
          try {
            await query(
              'UPDATE users SET is_active = $1 WHERE id = $2',
              [isActive, userId]
            );
            results.push({ userId, success: true });
          } catch (error) {
            results.push({ userId, success: false, error: error.message });
          }
        }
        break;

      case 'notify':
        if (!value.data?.message) {
          return res.status(400).json({
            success: false,
            message: 'Message is required for notify operation'
          });
        }
        
        const notificationResults = await sendBulkNotifications(
          value.user_ids,
          value.data.message,
          'admin_notification'
        );
        results.push(...notificationResults);
        break;

      case 'verify':
        // Implementation depends on user type verification logic
        break;
    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    res.json({
      success: true,
      message: `Bulk operation completed: ${successCount} successful, ${failureCount} failed`,
      data: {
        results,
        summary: {
          total: results.length,
          successful: successCount,
          failed: failureCount
        }
      }
    });

  } catch (error) {
    logger.error('Bulk operations error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to perform bulk operation'
    });
  }
});

// System configuration
router.get('/config', authenticate, authorize('admin'), async (req, res) => {
  try {
    // Return system configuration (this would typically come from a config table)
    const config = {
      delivery_fee: 8.00,
      pickup_margin: 3.00,
      max_orders_per_route: 12,
      max_route_distance: 100, // km
      rating_threshold_red: 2.5,
      rating_threshold_yellow: 4.0,
      supported_languages: ['hi', 'en'],
      payment_methods: ['upi', 'bank_transfer', 'cash'],
      vehicle_types: ['ev', 'bike', 'van'],
      notification_channels: ['sms', 'whatsapp', 'ivr', 'push']
    };

    res.json({
      success: true,
      data: config
    });

  } catch (error) {
    logger.error('Get config error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch configuration'
    });
  }
});

// Update system configuration
router.put('/config', authenticate, authorize('admin'), async (req, res) => {
  try {
    const schema = Joi.object({
      delivery_fee: Joi.number().positive().optional(),
      pickup_margin: Joi.number().positive().optional(),
      max_orders_per_route: Joi.number().integer().min(1).max(20).optional(),
      max_route_distance: Joi.number().positive().optional()
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // In a real implementation, you would store this in a configuration table
    // For now, we'll just return the updated values
    res.json({
      success: true,
      message: 'Configuration updated successfully',
      data: value
    });

  } catch (error) {
    logger.error('Update config error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update configuration'
    });
  }
});

// Export data
router.get('/export/:dataType', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { dataType } = req.params;
    const { format = 'json', start_date, end_date } = req.query;

    let data;
    let filename;

    switch (dataType) {
      case 'users':
        data = await query(`
          SELECT u.id, u.phone_number, u.user_type, u.is_active, u.created_at,
                 COALESCE(f.name, v.business_name, a.name) as name,
                 COALESCE(f.village, v.city, '') as location
          FROM users u
          LEFT JOIN farmers f ON u.id = f.user_id
          LEFT JOIN vendors v ON u.id = v.user_id  
          LEFT JOIN agents a ON u.id = a.user_id
          ORDER BY u.created_at DESC
        `);
        filename = 'users_export';
        break;

      case 'orders':
        let dateFilter = '';
        let params = [];
        if (start_date && end_date) {
          dateFilter = 'WHERE o.created_at BETWEEN $1 AND $2';
          params = [start_date, end_date];
        }

        data = await query(`
          SELECT o.*, f.name as farmer_name, v.business_name, p.name as product_name
          FROM orders o
          JOIN farmers f ON o.farmer_id = f.id
          JOIN vendors v ON o.vendor_id = v.id
          JOIN product_listings pl ON o.product_listing_id = pl.id
          JOIN products p ON pl.product_id = p.id
          ${dateFilter}
          ORDER BY o.created_at DESC
        `, params);
        filename = 'orders_export';
        break;

      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid data type'
        });
    }

    if (format === 'csv') {
      // Convert to CSV format
      const csv = convertToCSV(data.rows);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      res.send(csv);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
      res.json({
        success: true,
        data: data.rows,
        exported_at: new Date().toISOString(),
        total_records: data.rows.length
      });
    }

  } catch (error) {
    logger.error('Export data error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to export data'
    });
  }
});

// Helper function to convert JSON to CSV
const convertToCSV = (data) => {
  if (data.length === 0) return '';
  
  const headers = Object.keys(data[0]);
  const csvRows = [headers.join(',')];
  
  for (const row of data) {
    const values = headers.map(header => {
      const escaped = ('' + row[header]).replace(/"/g, '\\"');
      return `"${escaped}"`;
    });
    csvRows.push(values.join(','));
  }
  
  return csvRows.join('\n');
};

module.exports = router;