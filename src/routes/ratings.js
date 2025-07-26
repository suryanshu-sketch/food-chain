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

// Configure multer for rating images
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Submit rating for an order
router.post('/orders/:orderId', authenticate, upload.array('images', 3), async (req, res) => {
  try {
    const { orderId } = req.params;
    const schema = Joi.object({
      rating: Joi.number().integer().min(1).max(5).required(),
      hygiene_rating: Joi.number().integer().min(1).max(5).optional(),
      quality_rating: Joi.number().integer().min(1).max(5).optional(),
      delivery_rating: Joi.number().integer().min(1).max(5).optional(),
      comments: Joi.string().max(1000).optional()
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Verify user has access to rate this order
    const orderCheck = await query(
      `SELECT o.*, 
              CASE 
                WHEN f.user_id = $2 THEN v.user_id
                WHEN v.user_id = $2 THEN f.user_id
                WHEN a.user_id = $2 THEN 
                  CASE 
                    WHEN $3 = 'farmer' THEN f.user_id
                    WHEN $3 = 'vendor' THEN v.user_id
                  END
              END as rated_user
       FROM orders o
       JOIN farmers f ON o.farmer_id = f.id
       JOIN vendors v ON o.vendor_id = v.id
       LEFT JOIN route_orders ro ON o.id = ro.order_id
       LEFT JOIN routes rt ON ro.route_id = rt.id
       LEFT JOIN agents a ON rt.agent_id = a.id
       WHERE o.id = $1 AND o.status = 'delivered' AND (
         f.user_id = $2 OR v.user_id = $2 OR a.user_id = $2
       )`,
      [orderId, req.user.id, req.user.user_type]
    );

    if (orderCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Order not found or not eligible for rating'
      });
    }

    const order = orderCheck.rows[0];

    // Check if already rated
    const existingRating = await query(
      'SELECT id FROM ratings WHERE order_id = $1 AND rated_by = $2',
      [orderId, req.user.id]
    );

    if (existingRating.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'You have already rated this order'
      });
    }

    // Upload images if provided
    let imageUrls = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const key = `ratings/${req.user.id}/${Date.now()}-${file.originalname}`;
        const uploadParams = {
          Bucket: process.env.AWS_S3_BUCKET,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
          ACL: 'public-read'
        };

        const uploadResult = await s3.upload(uploadParams).promise();
        imageUrls.push(uploadResult.Location);
      }
    }

    const result = await transaction(async (client) => {
      // Create rating
      const rating = await client.query(
        `INSERT INTO ratings 
         (order_id, rated_by, rated_user, rating, hygiene_rating, quality_rating, delivery_rating, comments, images)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          orderId,
          req.user.id,
          order.rated_user,
          value.rating,
          value.hygiene_rating,
          value.quality_rating,
          value.delivery_rating,
          value.comments,
          JSON.stringify(imageUrls)
        ]
      );

      // Update farmer's hygiene rating if this is a farmer rating
      if (req.user.user_type === 'vendor') {
        const avgRating = await client.query(
          `SELECT AVG(r.hygiene_rating) as avg_hygiene,
                  AVG(r.rating) as avg_overall
           FROM ratings r
           JOIN users u ON r.rated_user = u.id
           WHERE u.user_type = 'farmer' AND r.rated_user = $1 AND r.hygiene_rating IS NOT NULL`,
          [order.rated_user]
        );

        if (avgRating.rows.length > 0) {
          const hygieneRating = parseFloat(avgRating.rows[0].avg_hygiene || 5.0);
          let hygieneBadge = 'green';
          
          if (hygieneRating < 2.5) {
            hygieneBadge = 'red';
          } else if (hygieneRating < 4.0) {
            hygieneBadge = 'yellow';
          }

          // Update farmer's hygiene rating and badge
          await client.query(
            `UPDATE farmers SET 
             hygiene_rating = $1,
             hygiene_badge = $2
             WHERE user_id = $3`,
            [hygieneRating, hygieneBadge, order.rated_user]
          );

          // If hygiene badge becomes red, suspend farmer temporarily
          if (hygieneBadge === 'red') {
            await client.query(
              'UPDATE users SET is_active = false WHERE id = $1',
              [order.rated_user]
            );

            // Notify admin about suspension
            const adminUsers = await client.query(
              'SELECT id FROM users WHERE user_type = $1',
              ['admin']
            );

            for (const admin of adminUsers.rows) {
              await sendNotification(
                admin.id,
                `Farmer suspended due to poor hygiene ratings. User ID: ${order.rated_user}`,
                'farmer_suspended',
                'urgent'
              );
            }
          }
        }
      }

      // Update agent rating if this is an agent rating
      if (req.user.user_type === 'vendor' || req.user.user_type === 'farmer') {
        const agentRating = await client.query(
          `SELECT rt.agent_id FROM route_orders ro
           JOIN routes rt ON ro.route_id = rt.id
           WHERE ro.order_id = $1`,
          [orderId]
        );

        if (agentRating.rows.length > 0) {
          const avgAgentRating = await client.query(
            `SELECT AVG(r.delivery_rating) as avg_delivery
             FROM ratings r
             JOIN orders o ON r.order_id = o.id
             JOIN route_orders ro ON o.id = ro.order_id
             JOIN routes rt ON ro.route_id = rt.id
             WHERE rt.agent_id = $1 AND r.delivery_rating IS NOT NULL`,
            [agentRating.rows[0].agent_id]
          );

          if (avgAgentRating.rows.length > 0) {
            await client.query(
              'UPDATE agents SET rating = $1 WHERE id = $2',
              [parseFloat(avgAgentRating.rows[0].avg_delivery || 5.0), agentRating.rows[0].agent_id]
            );
          }
        }
      }

      return rating.rows[0];
    });

    // Send notification to rated user
    await sendNotification(
      order.rated_user,
      `You received a ${value.rating}-star rating. ${value.comments ? `Comment: ${value.comments}` : ''}`,
      'rating_received'
    );

    res.status(201).json({
      success: true,
      message: 'Rating submitted successfully',
      data: result
    });

  } catch (error) {
    logger.error('Submit rating error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit rating'
    });
  }
});

// Get ratings for a user
router.get('/user/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 10, type } = req.query;
    const offset = (page - 1) * limit;

    // Verify user exists and get user type
    const userCheck = await query(
      'SELECT user_type FROM users WHERE id = $1',
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    let typeFilter = '';
    let params = [userId, limit, offset];

    if (type && ['hygiene', 'quality', 'delivery'].includes(type)) {
      typeFilter = `AND r.${type}_rating IS NOT NULL`;
    }

    const ratings = await query(
      `SELECT r.*, o.order_number,
              CASE 
                WHEN ru.user_type = 'farmer' THEN f.name
                WHEN ru.user_type = 'vendor' THEN v.business_name
                WHEN ru.user_type = 'agent' THEN a.name
                ELSE ru.phone_number
              END as rated_by_name,
              ru.user_type as rated_by_type
       FROM ratings r
       JOIN orders o ON r.order_id = o.id
       JOIN users ru ON r.rated_by = ru.id
       LEFT JOIN farmers f ON ru.id = f.user_id
       LEFT JOIN vendors v ON ru.id = v.user_id
       LEFT JOIN agents a ON ru.id = a.user_id
       WHERE r.rated_user = $1 ${typeFilter}
       ORDER BY r.created_at DESC
       LIMIT $2 OFFSET $3`,
      params
    );

    // Get rating summary
    const summary = await query(
      `SELECT 
         COUNT(*) as total_ratings,
         COALESCE(AVG(rating), 0) as avg_rating,
         COALESCE(AVG(hygiene_rating), 0) as avg_hygiene,
         COALESCE(AVG(quality_rating), 0) as avg_quality,
         COALESCE(AVG(delivery_rating), 0) as avg_delivery,
         COUNT(CASE WHEN rating = 5 THEN 1 END) as five_star,
         COUNT(CASE WHEN rating = 4 THEN 1 END) as four_star,
         COUNT(CASE WHEN rating = 3 THEN 1 END) as three_star,
         COUNT(CASE WHEN rating = 2 THEN 1 END) as two_star,
         COUNT(CASE WHEN rating = 1 THEN 1 END) as one_star
       FROM ratings
       WHERE rated_user = $1`,
      [userId]
    );

    res.json({
      success: true,
      data: {
        ratings: ratings.rows,
        summary: summary.rows[0],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(summary.rows[0].total_ratings)
        }
      }
    });

  } catch (error) {
    logger.error('Get user ratings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch ratings'
    });
  }
});

// Get rating details
router.get('/:ratingId', authenticate, async (req, res) => {
  try {
    const { ratingId } = req.params;

    const rating = await query(
      `SELECT r.*, o.order_number,
              CASE 
                WHEN rb.user_type = 'farmer' THEN f.name
                WHEN rb.user_type = 'vendor' THEN v.business_name
                WHEN rb.user_type = 'agent' THEN a.name
                ELSE rb.phone_number
              END as rated_by_name,
              rb.user_type as rated_by_type,
              CASE 
                WHEN ru.user_type = 'farmer' THEN fr.name
                WHEN ru.user_type = 'vendor' THEN vr.business_name
                WHEN ru.user_type = 'agent' THEN ar.name
                ELSE ru.phone_number
              END as rated_user_name,
              ru.user_type as rated_user_type
       FROM ratings r
       JOIN orders o ON r.order_id = o.id
       JOIN users rb ON r.rated_by = rb.id
       JOIN users ru ON r.rated_user = ru.id
       LEFT JOIN farmers f ON rb.id = f.user_id
       LEFT JOIN vendors v ON rb.id = v.user_id
       LEFT JOIN agents a ON rb.id = a.user_id
       LEFT JOIN farmers fr ON ru.id = fr.user_id
       LEFT JOIN vendors vr ON ru.id = vr.user_id
       LEFT JOIN agents ar ON ru.id = ar.user_id
       WHERE r.id = $1`,
      [ratingId]
    );

    if (rating.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Rating not found'
      });
    }

    // Check if user has access to view this rating
    const hasAccess = rating.rows[0].rated_by === req.user.id || 
                     rating.rows[0].rated_user === req.user.id ||
                     req.user.user_type === 'admin';

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    res.json({
      success: true,
      data: rating.rows[0]
    });

  } catch (error) {
    logger.error('Get rating details error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch rating details'
    });
  }
});

// Get hygiene leaderboard
router.get('/leaderboard/hygiene', authenticate, async (req, res) => {
  try {
    const { district, state, limit = 20 } = req.query;

    let whereConditions = ['f.hygiene_rating IS NOT NULL'];
    let params = [];
    let paramCount = 0;

    if (district) {
      paramCount++;
      whereConditions.push(`f.district = $${paramCount}`);
      params.push(district);
    }

    if (state) {
      paramCount++;
      whereConditions.push(`f.state = $${paramCount}`);
      params.push(state);
    }

    const leaderboard = await query(
      `SELECT f.name, f.village, f.district, f.state,
              f.hygiene_rating, f.hygiene_badge, f.total_deliveries,
              COUNT(r.id) as total_ratings,
              COALESCE(AVG(r.hygiene_rating), f.hygiene_rating) as avg_hygiene_rating,
              RANK() OVER (ORDER BY f.hygiene_rating DESC, f.total_deliveries DESC) as rank
       FROM farmers f
       LEFT JOIN ratings r ON f.user_id = r.rated_user AND r.hygiene_rating IS NOT NULL
       WHERE ${whereConditions.join(' AND ')}
       GROUP BY f.id, f.name, f.village, f.district, f.state, f.hygiene_rating, f.hygiene_badge, f.total_deliveries
       ORDER BY f.hygiene_rating DESC, f.total_deliveries DESC
       LIMIT $${paramCount + 1}`,
      [...params, limit]
    );

    res.json({
      success: true,
      data: leaderboard.rows
    });

  } catch (error) {
    logger.error('Get hygiene leaderboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch hygiene leaderboard'
    });
  }
});

// Report inappropriate rating (admin action)
router.post('/:ratingId/report', authenticate, async (req, res) => {
  try {
    const { ratingId } = req.params;
    const { reason } = req.body;

    // Check if rating exists
    const rating = await query(
      'SELECT * FROM ratings WHERE id = $1',
      [ratingId]
    );

    if (rating.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Rating not found'
      });
    }

    // Create report (you might want to create a separate reports table)
    await query(
      `INSERT INTO analytics_events (user_id, event_type, event_data)
       VALUES ($1, $2, $3)`,
      [
        req.user.id,
        'rating_reported',
        JSON.stringify({
          rating_id: ratingId,
          reason: reason,
          reported_by: req.user.id,
          timestamp: new Date().toISOString()
        })
      ]
    );

    // Notify admin
    const adminUsers = await query(
      'SELECT id FROM users WHERE user_type = $1',
      ['admin']
    );

    const notifications = adminUsers.rows.map(admin => 
      sendNotification(
        admin.id,
        `Rating reported: ${reason}. Rating ID: ${ratingId}`,
        'rating_reported',
        'normal'
      )
    );

    await Promise.allSettled(notifications);

    res.json({
      success: true,
      message: 'Rating reported successfully'
    });

  } catch (error) {
    logger.error('Report rating error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to report rating'
    });
  }
});

// Get rating analytics (admin only)
router.get('/analytics/summary', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { period = '30' } = req.query;

    const [
      overallStats,
      hygieneStats,
      qualityStats,
      deliveryStats,
      trendData
    ] = await Promise.all([
      // Overall rating statistics
      query(
        `SELECT 
           COUNT(*) as total_ratings,
           COALESCE(AVG(rating), 0) as avg_rating,
           COUNT(CASE WHEN rating >= 4 THEN 1 END) as positive_ratings,
           COUNT(CASE WHEN rating <= 2 THEN 1 END) as negative_ratings
         FROM ratings
         WHERE created_at >= CURRENT_DATE - INTERVAL $1 DAY`,
        [`${period} days`]
      ),

      // Hygiene rating statistics
      query(
        `SELECT 
           COUNT(*) as total_hygiene_ratings,
           COALESCE(AVG(hygiene_rating), 0) as avg_hygiene,
           COUNT(CASE WHEN hygiene_rating >= 4 THEN 1 END) as good_hygiene,
           COUNT(CASE WHEN hygiene_rating <= 2 THEN 1 END) as poor_hygiene
         FROM ratings
         WHERE hygiene_rating IS NOT NULL AND created_at >= CURRENT_DATE - INTERVAL $1 DAY`,
        [`${period} days`]
      ),

      // Quality rating statistics
      query(
        `SELECT 
           COUNT(*) as total_quality_ratings,
           COALESCE(AVG(quality_rating), 0) as avg_quality,
           COUNT(CASE WHEN quality_rating >= 4 THEN 1 END) as good_quality,
           COUNT(CASE WHEN quality_rating <= 2 THEN 1 END) as poor_quality
         FROM ratings
         WHERE quality_rating IS NOT NULL AND created_at >= CURRENT_DATE - INTERVAL $1 DAY`,
        [`${period} days`]
      ),

      // Delivery rating statistics
      query(
        `SELECT 
           COUNT(*) as total_delivery_ratings,
           COALESCE(AVG(delivery_rating), 0) as avg_delivery,
           COUNT(CASE WHEN delivery_rating >= 4 THEN 1 END) as good_delivery,
           COUNT(CASE WHEN delivery_rating <= 2 THEN 1 END) as poor_delivery
         FROM ratings
         WHERE delivery_rating IS NOT NULL AND created_at >= CURRENT_DATE - INTERVAL $1 DAY`,
        [`${period} days`]
      ),

      // Daily rating trend
      query(
        `SELECT DATE(created_at) as rating_date,
                COUNT(*) as daily_ratings,
                COALESCE(AVG(rating), 0) as daily_avg_rating
         FROM ratings
         WHERE created_at >= CURRENT_DATE - INTERVAL $1 DAY
         GROUP BY DATE(created_at)
         ORDER BY rating_date`,
        [`${period} days`]
      )
    ]);

    res.json({
      success: true,
      data: {
        overall: overallStats.rows[0],
        hygiene: hygieneStats.rows[0],
        quality: qualityStats.rows[0],
        delivery: deliveryStats.rows[0],
        trend: trendData.rows
      }
    });

  } catch (error) {
    logger.error('Get rating analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch rating analytics'
    });
  }
});

module.exports = router;