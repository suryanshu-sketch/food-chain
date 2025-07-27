const express = require('express');
const Joi = require('joi');
const { query } = require('../database/connection');
const { authenticate, authorize } = require('../middleware/auth');
const { 
  sendSMS, 
  sendWhatsApp, 
  makeIVRCall, 
  sendNotification,
  sendBulkNotifications,
  handleWhatsAppWebhook,
  processIncomingMessage 
} = require('../services/communications');
const logger = require('../utils/logger');

const router = express.Router();

// WhatsApp webhook endpoint
router.post('/whatsapp/webhook', handleWhatsAppWebhook);

// IVR webhook endpoint for Exotel callbacks
router.post('/ivr/webhook', async (req, res) => {
  try {
    const { CallSid, CallStatus, From, To, Digits } = req.body;

    // Log IVR interaction
    const phoneNumber = From?.replace('+91', '');
    
    if (phoneNumber) {
      const userResult = await query(
        'SELECT id FROM users WHERE phone_number = $1',
        [phoneNumber]
      );

      if (userResult.rows.length > 0) {
        await query(
          'INSERT INTO communications (user_id, type, direction, content, status, external_id, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [
            userResult.rows[0].id,
            'ivr',
            'inbound',
            `IVR interaction - Digits: ${Digits || 'none'}`,
            'received',
            CallSid,
            JSON.stringify({ CallStatus, Digits })
          ]
        );

        // Process IVR menu selection
        if (Digits) {
          await processIVRSelection(userResult.rows[0].id, Digits);
        }
      }
    }

    // Return TwiML response based on digits pressed
    let twimlResponse = '<?xml version="1.0" encoding="UTF-8"?><Response>';
    
    switch (Digits) {
      case '1':
        twimlResponse += '<Say voice="alice" language="hi-IN">आपके हाल के ऑर्डर की जानकारी SMS में भेजी जा रही है।</Say>';
        break;
      case '2':
        twimlResponse += '<Say voice="alice" language="hi-IN">सपोर्ट टीम से जुड़ा जा रहा है। कृपया प्रतीक्षा करें।</Say>';
        twimlResponse += '<Dial timeout="30">+911234567890</Dial>';
        break;
      case '3':
        twimlResponse += '<Say voice="alice" language="hi-IN">आपकी पेमेंट की जानकारी SMS में भेजी जा रही है।</Say>';
        break;
      default:
        twimlResponse += '<Say voice="alice" language="hi-IN">मुख्य मेनू के लिए: ऑर्डर की जानकारी के लिए 1 दबाएं, सपोर्ट के लिए 2 दबाएं, पेमेंट की जानकारी के लिए 3 दबाएं।</Say>';
        twimlResponse += '<Gather timeout="10" numDigits="1" action="/api/communications/ivr/webhook" method="POST"></Gather>';
    }
    
    twimlResponse += '</Response>';

    res.set('Content-Type', 'text/xml');
    res.send(twimlResponse);

  } catch (error) {
    logger.error('IVR webhook error:', error);
    res.status(500).send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>System error occurred</Say></Response>');
  }
});

// Process IVR menu selections
const processIVRSelection = async (userId, digits) => {
  try {
    switch (digits) {
      case '1':
        // Send recent orders info
        const orders = await query(
          `SELECT o.order_number, o.status, p.name as product_name, o.quantity
           FROM orders o
           JOIN product_listings pl ON o.product_listing_id = pl.id
           JOIN products p ON pl.product_id = p.id
           WHERE o.farmer_id = (SELECT id FROM farmers WHERE user_id = $1) 
              OR o.vendor_id = (SELECT id FROM vendors WHERE user_id = $1)
           ORDER BY o.created_at DESC
           LIMIT 3`,
          [userId]
        );

        let orderMessage = 'आपके हाल के ऑर्डर:\n';
        orders.rows.forEach((order, index) => {
          orderMessage += `${index + 1}. ${order.order_number} - ${order.product_name} (${order.quantity}kg) - ${order.status}\n`;
        });

        await sendNotification(userId, orderMessage, 'ivr_order_inquiry');
        break;

      case '3':
        // Send payment info
        const payments = await query(
          `SELECT p.amount, p.status, p.transaction_id, o.order_number
           FROM payments p
           JOIN orders o ON p.order_id = o.id
           WHERE p.farmer_id = (SELECT id FROM farmers WHERE user_id = $1)
           ORDER BY p.created_at DESC
           LIMIT 3`,
          [userId]
        );

        let paymentMessage = 'आपकी हाल की पेमेंट:\n';
        payments.rows.forEach((payment, index) => {
          paymentMessage += `${index + 1}. ₹${payment.amount} - ${payment.status} (${payment.order_number})\n`;
        });

        await sendNotification(userId, paymentMessage, 'ivr_payment_inquiry');
        break;
    }
  } catch (error) {
    logger.error('Process IVR selection error:', error);
  }
};

// Send manual notification (admin only)
router.post('/send', authenticate, authorize('admin'), async (req, res) => {
  try {
    const schema = Joi.object({
      recipients: Joi.array().items(Joi.string().uuid()).required(),
      message: Joi.string().max(1000).required(),
      type: Joi.string().valid('sms', 'whatsapp', 'push', 'auto').default('auto'),
      priority: Joi.string().valid('normal', 'urgent').default('normal'),
      template_name: Joi.string().optional(),
      template_params: Joi.array().optional()
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    let results;

    if (value.type === 'auto') {
      // Use smart notification system
      results = await sendBulkNotifications(
        value.recipients,
        value.message,
        'manual_notification'
      );
    } else {
      // Send via specific channel
      results = [];
      for (const userId of value.recipients) {
        try {
          const user = await query(
            'SELECT phone_number FROM users WHERE id = $1',
            [userId]
          );

          if (user.rows.length > 0) {
            const phoneNumber = user.rows[0].phone_number;
            
            if (value.type === 'sms') {
              await sendSMS(phoneNumber, value.message, userId);
            } else if (value.type === 'whatsapp') {
              await sendWhatsApp(
                phoneNumber, 
                value.message, 
                userId,
                value.template_name,
                value.template_params
              );
            }

            results.push({ userId, success: true, method: value.type });
          } else {
            results.push({ userId, success: false, error: 'User not found' });
          }
        } catch (error) {
          results.push({ userId, success: false, error: error.message });
        }
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.filter(r => !r.success).length;

    res.json({
      success: true,
      message: `Notifications sent: ${successCount} successful, ${failureCount} failed`,
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
    logger.error('Send notification error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send notifications'
    });
  }
});

// Get communication history for a user
router.get('/history/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    const { type, direction, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    // Check access permissions
    if (req.user.user_type !== 'admin' && req.user.id !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    let whereConditions = ['user_id = $1'];
    let params = [userId];
    let paramCount = 1;

    if (type) {
      paramCount++;
      whereConditions.push(`type = $${paramCount}`);
      params.push(type);
    }

    if (direction) {
      paramCount++;
      whereConditions.push(`direction = $${paramCount}`);
      params.push(direction);
    }

    const communications = await query(
      `SELECT * FROM communications
       WHERE ${whereConditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`,
      [...params, limit, offset]
    );

    // Get total count
    const totalResult = await query(
      `SELECT COUNT(*) as total FROM communications
       WHERE ${whereConditions.join(' AND ')}`,
      params
    );

    res.json({
      success: true,
      data: {
        communications: communications.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(totalResult.rows[0].total),
          pages: Math.ceil(totalResult.rows[0].total / limit)
        }
      }
    });

  } catch (error) {
    logger.error('Get communication history error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch communication history'
    });
  }
});

// Get communication analytics (admin only)
router.get('/analytics', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { period = '30', type } = req.query;

    let typeFilter = '';
    let params = [`${period} days`];

    if (type) {
      typeFilter = 'AND type = $2';
      params.push(type);
    }

    const [
      overallStats,
      typeBreakdown,
      statusBreakdown,
      dailyTrend,
      costAnalysis
    ] = await Promise.all([
      // Overall communication statistics
      query(
        `SELECT 
           COUNT(*) as total_communications,
           COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered_count,
           COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count,
           COALESCE(SUM(cost), 0) as total_cost,
           COALESCE(AVG(cost), 0) as avg_cost
         FROM communications
         WHERE created_at >= CURRENT_DATE - INTERVAL $1 ${typeFilter}`,
        params
      ),

      // Communication type breakdown
      query(
        `SELECT type,
                COUNT(*) as count,
                COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered,
                COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
                COALESCE(SUM(cost), 0) as total_cost
         FROM communications
         WHERE created_at >= CURRENT_DATE - INTERVAL $1
         GROUP BY type
         ORDER BY count DESC`,
        [`${period} days`]
      ),

      // Status breakdown
      query(
        `SELECT status,
                COUNT(*) as count,
                ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 2) as percentage
         FROM communications
         WHERE created_at >= CURRENT_DATE - INTERVAL $1 ${typeFilter}
         GROUP BY status`,
        params
      ),

      // Daily communication trend
      query(
        `SELECT DATE(created_at) as date,
                COUNT(*) as total_count,
                COUNT(CASE WHEN type = 'sms' THEN 1 END) as sms_count,
                COUNT(CASE WHEN type = 'whatsapp' THEN 1 END) as whatsapp_count,
                COUNT(CASE WHEN type = 'ivr' THEN 1 END) as ivr_count,
                COALESCE(SUM(cost), 0) as daily_cost
         FROM communications
         WHERE created_at >= CURRENT_DATE - INTERVAL $1
         GROUP BY DATE(created_at)
         ORDER BY date`,
        [`${period} days`]
      ),

      // Cost analysis by type
      query(
        `SELECT type,
                COUNT(*) as message_count,
                COALESCE(SUM(cost), 0) as total_cost,
                COALESCE(AVG(cost), 0) as avg_cost_per_message,
                COALESCE(MIN(cost), 0) as min_cost,
                COALESCE(MAX(cost), 0) as max_cost
         FROM communications
         WHERE created_at >= CURRENT_DATE - INTERVAL $1 AND cost > 0
         GROUP BY type
         ORDER BY total_cost DESC`,
        [`${period} days`]
      )
    ]);

    res.json({
      success: true,
      data: {
        overall: overallStats.rows[0],
        by_type: typeBreakdown.rows,
        by_status: statusBreakdown.rows,
        daily_trend: dailyTrend.rows,
        cost_analysis: costAnalysis.rows
      }
    });

  } catch (error) {
    logger.error('Get communication analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch communication analytics'
    });
  }
});

// Test communication channels (admin only)
router.post('/test', authenticate, authorize('admin'), async (req, res) => {
  try {
    const schema = Joi.object({
      phone_number: Joi.string().pattern(/^[6-9]\d{9}$/).required(),
      channels: Joi.array().items(Joi.string().valid('sms', 'whatsapp', 'ivr')).required(),
      test_message: Joi.string().max(160).default('Test message from AgriSupply system')
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const results = [];

    for (const channel of value.channels) {
      try {
        let result;
        
        switch (channel) {
          case 'sms':
            result = await sendSMS(value.phone_number, value.test_message);
            break;
          case 'whatsapp':
            result = await sendWhatsApp(value.phone_number, value.test_message);
            break;
          case 'ivr':
            result = await makeIVRCall(value.phone_number, 'test_flow');
            break;
        }

        results.push({
          channel,
          success: true,
          result
        });

      } catch (error) {
        results.push({
          channel,
          success: false,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      message: 'Communication test completed',
      data: results
    });

  } catch (error) {
    logger.error('Test communication error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to test communication channels'
    });
  }
});

// Update communication preferences (user)
router.put('/preferences', authenticate, async (req, res) => {
  try {
    const schema = Joi.object({
      preferred_language: Joi.string().valid('hi', 'en').default('hi'),
      sms_enabled: Joi.boolean().default(true),
      whatsapp_enabled: Joi.boolean().default(true),
      ivr_enabled: Joi.boolean().default(true),
      notification_types: Joi.object({
        order_updates: Joi.boolean().default(true),
        payment_updates: Joi.boolean().default(true),
        promotional: Joi.boolean().default(false),
        system_alerts: Joi.boolean().default(true)
      }).default({})
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Update user preferences based on user type
    let updateQuery;
    let params;

    if (req.user.user_type === 'farmer') {
      updateQuery = `
        UPDATE farmers SET 
        preferred_language = $2
        WHERE user_id = $1
        RETURNING *
      `;
      params = [req.user.id, value.preferred_language];
    } else {
      // For vendors and agents, we might store preferences in a separate table
      // For now, we'll create a simple preferences record
      await query(
        `INSERT INTO user_preferences (user_id, preferences) 
         VALUES ($1, $2)
         ON CONFLICT (user_id) 
         DO UPDATE SET preferences = $2, updated_at = CURRENT_TIMESTAMP`,
        [req.user.id, JSON.stringify(value)]
      );
    }

    if (updateQuery) {
      await query(updateQuery, params);
    }

    res.json({
      success: true,
      message: 'Communication preferences updated successfully',
      data: value
    });

  } catch (error) {
    logger.error('Update preferences error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update communication preferences'
    });
  }
});

// Create user preferences table if it doesn't exist
const createPreferencesTable = async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        preferences JSON NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (error) {
    logger.error('Failed to create user preferences table:', error);
  }
};

createPreferencesTable();

module.exports = router;