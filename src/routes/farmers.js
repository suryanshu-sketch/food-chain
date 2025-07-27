const express = require('express');
const Joi = require('joi');
const multer = require('multer');
const AWS = require('aws-sdk');
const QRCode = require('qrcode');
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

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Get farmer dashboard data
router.get('/dashboard', authenticate, authorize('farmer'), async (req, res) => {
  try {
    const farmerId = await query(
      'SELECT id FROM farmers WHERE user_id = $1',
      [req.user.id]
    );

    if (farmerId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Farmer profile not found'
      });
    }

    const farmerUUID = farmerId.rows[0].id;

    // Get dashboard statistics
    const [
      activeListings,
      totalOrders,
      pendingOrders,
      completedOrders,
      totalEarnings,
      recentOrders
    ] = await Promise.all([
      query(
        'SELECT COUNT(*) as count FROM product_listings WHERE farmer_id = $1 AND status = $2',
        [farmerUUID, 'available']
      ),
      query(
        'SELECT COUNT(*) as count FROM orders WHERE farmer_id = $1',
        [farmerUUID]
      ),
      query(
        'SELECT COUNT(*) as count FROM orders WHERE farmer_id = $1 AND status IN ($2, $3, $4)',
        [farmerUUID, 'placed', 'confirmed', 'picked']
      ),
      query(
        'SELECT COUNT(*) as count FROM orders WHERE farmer_id = $1 AND status = $2',
        [farmerUUID, 'delivered']
      ),
      query(
        'SELECT COALESCE(SUM(total_amount), 0) as total FROM orders WHERE farmer_id = $1 AND status = $2',
        [farmerUUID, 'delivered']
      ),
      query(
        `SELECT o.*, p.name as product_name, v.business_name 
         FROM orders o 
         JOIN product_listings pl ON o.product_listing_id = pl.id 
         JOIN products p ON pl.product_id = p.id 
         JOIN vendors v ON o.vendor_id = v.id 
         WHERE o.farmer_id = $1 
         ORDER BY o.created_at DESC 
         LIMIT 5`,
        [farmerUUID]
      )
    ]);

    res.json({
      success: true,
      data: {
        statistics: {
          active_listings: parseInt(activeListings.rows[0].count),
          total_orders: parseInt(totalOrders.rows[0].count),
          pending_orders: parseInt(pendingOrders.rows[0].count),
          completed_orders: parseInt(completedOrders.rows[0].count),
          total_earnings: parseFloat(totalEarnings.rows[0].total)
        },
        recent_orders: recentOrders.rows
      }
    });

  } catch (error) {
    logger.error('Farmer dashboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard data'
    });
  }
});

// Get all products (for listing creation)
router.get('/products', authenticate, authorize('farmer'), async (req, res) => {
  try {
    const products = await query(
      'SELECT * FROM products ORDER BY category, name'
    );

    res.json({
      success: true,
      data: products.rows
    });

  } catch (error) {
    logger.error('Get products error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products'
    });
  }
});

// Create product listing
router.post('/listings', authenticate, authorize('farmer'), upload.array('images', 3), async (req, res) => {
  try {
    const schema = Joi.object({
      product_id: Joi.string().uuid().required(),
      quantity: Joi.number().positive().required(),
      price_per_unit: Joi.number().positive().required(),
      harvest_date: Joi.date().required(),
      expiry_date: Joi.date().optional(),
      quality_grade: Joi.string().valid('A', 'B', 'C').default('A'),
      description: Joi.string().max(500).optional()
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const farmerId = await query(
      'SELECT id FROM farmers WHERE user_id = $1',
      [req.user.id]
    );

    if (farmerId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Farmer profile not found'
      });
    }

    const farmerUUID = farmerId.rows[0].id;

    // Upload images to S3
    let imageUrls = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const key = `listings/${farmerUUID}/${Date.now()}-${file.originalname}`;
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

    // Generate QR code for the listing
    const listingId = require('crypto').randomUUID();
    const qrCode = await QRCode.toDataURL(`listing:${listingId}`);

    // Create listing
    const listing = await query(
      `INSERT INTO product_listings 
       (id, farmer_id, product_id, quantity, price_per_unit, harvest_date, expiry_date, quality_grade, description, images, qr_code) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) 
       RETURNING *`,
      [
        listingId,
        farmerUUID,
        value.product_id,
        value.quantity,
        value.price_per_unit,
        value.harvest_date,
        value.expiry_date,
        value.quality_grade,
        value.description,
        JSON.stringify(imageUrls),
        qrCode
      ]
    );

    // Send confirmation notification
    await sendNotification(
      req.user.id,
      `आपका ${value.quantity}kg उत्पाद सफलतापूर्वक लिस्ट हो गया है।`,
      'listing_created'
    );

    res.status(201).json({
      success: true,
      message: 'Product listing created successfully',
      data: listing.rows[0]
    });

  } catch (error) {
    logger.error('Create listing error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create product listing'
    });
  }
});

// Get farmer's listings
router.get('/listings', authenticate, authorize('farmer'), async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    const farmerId = await query(
      'SELECT id FROM farmers WHERE user_id = $1',
      [req.user.id]
    );

    if (farmerId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Farmer profile not found'
      });
    }

    const farmerUUID = farmerId.rows[0].id;

    let whereClause = 'WHERE pl.farmer_id = $1';
    let params = [farmerUUID];

    if (status) {
      whereClause += ' AND pl.status = $2';
      params.push(status);
    }

    const listings = await query(
      `SELECT pl.*, p.name as product_name, p.category, p.unit,
              COUNT(o.id) as order_count,
              COALESCE(SUM(o.quantity), 0) as total_ordered
       FROM product_listings pl
       JOIN products p ON pl.product_id = p.id
       LEFT JOIN orders o ON pl.id = o.product_listing_id
       ${whereClause}
       GROUP BY pl.id, p.name, p.category, p.unit
       ORDER BY pl.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    // Get total count for pagination
    const totalResult = await query(
      `SELECT COUNT(*) as total FROM product_listings pl ${whereClause}`,
      params
    );

    res.json({
      success: true,
      data: {
        listings: listings.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(totalResult.rows[0].total),
          pages: Math.ceil(totalResult.rows[0].total / limit)
        }
      }
    });

  } catch (error) {
    logger.error('Get listings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch listings'
    });
  }
});

// Update listing
router.put('/listings/:id', authenticate, authorize('farmer'), upload.array('images', 3), async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const farmerId = await query(
      'SELECT id FROM farmers WHERE user_id = $1',
      [req.user.id]
    );

    if (farmerId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Farmer profile not found'
      });
    }

    const farmerUUID = farmerId.rows[0].id;

    // Check if listing belongs to farmer
    const listingCheck = await query(
      'SELECT * FROM product_listings WHERE id = $1 AND farmer_id = $2',
      [id, farmerUUID]
    );

    if (listingCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Listing not found'
      });
    }

    // Handle image uploads
    let imageUrls = JSON.parse(listingCheck.rows[0].images || '[]');
    if (req.files && req.files.length > 0) {
      // Upload new images
      for (const file of req.files) {
        const key = `listings/${farmerUUID}/${Date.now()}-${file.originalname}`;
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

    // Update listing
    const updatedListing = await query(
      `UPDATE product_listings SET 
       quantity = COALESCE($2, quantity),
       price_per_unit = COALESCE($3, price_per_unit),
       harvest_date = COALESCE($4, harvest_date),
       expiry_date = COALESCE($5, expiry_date),
       quality_grade = COALESCE($6, quality_grade),
       description = COALESCE($7, description),
       images = $8,
       status = COALESCE($9, status)
       WHERE id = $1 AND farmer_id = $10
       RETURNING *`,
      [
        id,
        updates.quantity,
        updates.price_per_unit,
        updates.harvest_date,
        updates.expiry_date,
        updates.quality_grade,
        updates.description,
        JSON.stringify(imageUrls),
        updates.status,
        farmerUUID
      ]
    );

    res.json({
      success: true,
      message: 'Listing updated successfully',
      data: updatedListing.rows[0]
    });

  } catch (error) {
    logger.error('Update listing error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update listing'
    });
  }
});

// Get farmer's orders
router.get('/orders', authenticate, authorize('farmer'), async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    const farmerId = await query(
      'SELECT id FROM farmers WHERE user_id = $1',
      [req.user.id]
    );

    if (farmerId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Farmer profile not found'
      });
    }

    const farmerUUID = farmerId.rows[0].id;

    let whereClause = 'WHERE o.farmer_id = $1';
    let params = [farmerUUID];

    if (status) {
      whereClause += ' AND o.status = $2';
      params.push(status);
    }

    const orders = await query(
      `SELECT o.*, p.name as product_name, p.unit,
              v.business_name, v.owner_name,
              pl.quality_grade,
              r.rating, r.comments
       FROM orders o
       JOIN product_listings pl ON o.product_listing_id = pl.id
       JOIN products p ON pl.product_id = p.id
       JOIN vendors v ON o.vendor_id = v.id
       LEFT JOIN ratings r ON o.id = r.order_id AND r.rated_user = (SELECT user_id FROM farmers WHERE id = o.farmer_id)
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      data: orders.rows
    });

  } catch (error) {
    logger.error('Get farmer orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch orders'
    });
  }
});

// Confirm order (farmer accepts the order)
router.post('/orders/:orderId/confirm', authenticate, authorize('farmer'), async (req, res) => {
  try {
    const { orderId } = req.params;

    const farmerId = await query(
      'SELECT id FROM farmers WHERE user_id = $1',
      [req.user.id]
    );

    if (farmerId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Farmer profile not found'
      });
    }

    const farmerUUID = farmerId.rows[0].id;

    // Update order status and send notifications
    const result = await transaction(async (client) => {
      // Update order status
      const orderUpdate = await client.query(
        'UPDATE orders SET status = $1 WHERE id = $2 AND farmer_id = $3 AND status = $4 RETURNING *',
        ['confirmed', orderId, farmerUUID, 'placed']
      );

      if (orderUpdate.rows.length === 0) {
        throw new Error('Order not found or cannot be confirmed');
      }

      const order = orderUpdate.rows[0];

      // Get vendor details for notification
      const vendor = await client.query(
        'SELECT user_id FROM vendors WHERE id = $1',
        [order.vendor_id]
      );

      // Send notification to vendor
      if (vendor.rows.length > 0) {
        await sendNotification(
          vendor.rows[0].user_id,
          `Order #${order.order_number} confirmed by farmer. Pickup will be scheduled soon.`,
          'order_confirmed'
        );
      }

      return order;
    });

    // Send confirmation to farmer
    await sendNotification(
      req.user.id,
      `आपने ऑर्डर #${result.order_number} को कन्फर्म कर दिया है।`,
      'order_confirmed'
    );

    res.json({
      success: true,
      message: 'Order confirmed successfully',
      data: result
    });

  } catch (error) {
    logger.error('Confirm order error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to confirm order'
    });
  }
});

// Get farmer's earnings and payments
router.get('/earnings', authenticate, authorize('farmer'), async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    const farmerId = await query(
      'SELECT id FROM farmers WHERE user_id = $1',
      [req.user.id]
    );

    if (farmerId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Farmer profile not found'
      });
    }

    const farmerUUID = farmerId.rows[0].id;

    let dateFilter = '';
    let params = [farmerUUID];

    if (start_date && end_date) {
      dateFilter = 'AND p.created_at BETWEEN $2 AND $3';
      params.push(start_date, end_date);
    }

    const earnings = await query(
      `SELECT 
         COALESCE(SUM(p.amount), 0) as total_earnings,
         COUNT(p.id) as total_payments,
         COALESCE(SUM(CASE WHEN p.status = 'completed' THEN p.amount ELSE 0 END), 0) as received_amount,
         COALESCE(SUM(CASE WHEN p.status = 'pending' THEN p.amount ELSE 0 END), 0) as pending_amount
       FROM payments p
       WHERE p.farmer_id = $1 ${dateFilter}`,
      params
    );

    // Get recent payments
    const recentPayments = await query(
      `SELECT p.*, o.order_number
       FROM payments p
       JOIN orders o ON p.order_id = o.id
       WHERE p.farmer_id = $1
       ORDER BY p.created_at DESC
       LIMIT 10`,
      [farmerUUID]
    );

    res.json({
      success: true,
      data: {
        summary: earnings.rows[0],
        recent_payments: recentPayments.rows
      }
    });

  } catch (error) {
    logger.error('Get earnings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch earnings'
    });
  }
});

// Get farmer's QR code
router.get('/qr-code', authenticate, authorize('farmer'), async (req, res) => {
  try {
    const farmer = await query(
      'SELECT qr_code FROM farmers WHERE user_id = $1',
      [req.user.id]
    );

    if (farmer.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Farmer profile not found'
      });
    }

    res.json({
      success: true,
      data: {
        qr_code: farmer.rows[0].qr_code
      }
    });

  } catch (error) {
    logger.error('Get QR code error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch QR code'
    });
  }
});

module.exports = router;