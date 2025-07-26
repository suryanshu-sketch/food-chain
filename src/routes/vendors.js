const express = require('express');
const Joi = require('joi');
const { query, transaction } = require('../database/connection');
const { authenticate, authorize } = require('../middleware/auth');
const { sendNotification } = require('../services/communications');
const logger = require('../utils/logger');
const geolib = require('geolib');

const router = express.Router();

// Get vendor dashboard
router.get('/dashboard', authenticate, authorize('vendor'), async (req, res) => {
  try {
    const vendorId = await query(
      'SELECT id FROM vendors WHERE user_id = $1',
      [req.user.id]
    );

    if (vendorId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vendor profile not found'
      });
    }

    const vendorUUID = vendorId.rows[0].id;

    // Get dashboard statistics
    const [
      totalOrders,
      pendingOrders,
      completedOrders,
      totalSpent,
      recentOrders,
      nearbyFarmers
    ] = await Promise.all([
      query(
        'SELECT COUNT(*) as count FROM orders WHERE vendor_id = $1',
        [vendorUUID]
      ),
      query(
        'SELECT COUNT(*) as count FROM orders WHERE vendor_id = $1 AND status IN ($2, $3, $4, $5)',
        [vendorUUID, 'placed', 'confirmed', 'picked', 'in_transit']
      ),
      query(
        'SELECT COUNT(*) as count FROM orders WHERE vendor_id = $1 AND status = $2',
        [vendorUUID, 'delivered']
      ),
      query(
        'SELECT COALESCE(SUM(total_amount + delivery_fee), 0) as total FROM orders WHERE vendor_id = $1 AND status = $2',
        [vendorUUID, 'delivered']
      ),
      query(
        `SELECT o.*, p.name as product_name, f.name as farmer_name, f.village
         FROM orders o 
         JOIN product_listings pl ON o.product_listing_id = pl.id 
         JOIN products p ON pl.product_id = p.id 
         JOIN farmers f ON o.farmer_id = f.id 
         WHERE o.vendor_id = $1 
         ORDER BY o.created_at DESC 
         LIMIT 5`,
        [vendorUUID]
      ),
      query(
        `SELECT f.*, 
                ST_Distance(f.location, v.location) as distance,
                COUNT(pl.id) as available_products
         FROM farmers f
         JOIN vendors v ON v.id = $1
         LEFT JOIN product_listings pl ON f.id = pl.farmer_id AND pl.status = 'available'
         WHERE ST_DWithin(f.location, v.location, 50000) -- 50km radius
         GROUP BY f.id, f.name, f.village, f.hygiene_rating, f.location, v.location
         ORDER BY distance
         LIMIT 10`,
        [vendorUUID]
      )
    ]);

    res.json({
      success: true,
      data: {
        statistics: {
          total_orders: parseInt(totalOrders.rows[0].count),
          pending_orders: parseInt(pendingOrders.rows[0].count),
          completed_orders: parseInt(completedOrders.rows[0].count),
          total_spent: parseFloat(totalSpent.rows[0].total)
        },
        recent_orders: recentOrders.rows,
        nearby_farmers: nearbyFarmers.rows
      }
    });

  } catch (error) {
    logger.error('Vendor dashboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard data'
    });
  }
});

// Browse available products from farmers
router.get('/products', authenticate, authorize('vendor'), async (req, res) => {
  try {
    const { 
      category, 
      location, 
      radius = 50, 
      min_price, 
      max_price, 
      quality_grade,
      page = 1, 
      limit = 20 
    } = req.query;
    
    const offset = (page - 1) * limit;

    // Get vendor location for distance calculations
    const vendorLocation = await query(
      'SELECT ST_X(location::geometry) as longitude, ST_Y(location::geometry) as latitude FROM vendors WHERE user_id = $1',
      [req.user.id]
    );

    let whereConditions = ['pl.status = $1'];
    let params = ['available'];
    let paramCount = 1;

    // Add filters
    if (category) {
      paramCount++;
      whereConditions.push(`p.category = $${paramCount}`);
      params.push(category);
    }

    if (min_price) {
      paramCount++;
      whereConditions.push(`pl.price_per_unit >= $${paramCount}`);
      params.push(min_price);
    }

    if (max_price) {
      paramCount++;
      whereConditions.push(`pl.price_per_unit <= $${paramCount}`);
      params.push(max_price);
    }

    if (quality_grade) {
      paramCount++;
      whereConditions.push(`pl.quality_grade = $${paramCount}`);
      params.push(quality_grade);
    }

    // Location-based filtering
    if (vendorLocation.rows.length > 0 && location) {
      const [lat, lng] = location.split(',').map(Number);
      paramCount += 2;
      whereConditions.push(`ST_DWithin(f.location, ST_SetSRID(ST_MakePoint($${paramCount}, $${paramCount-1}), 4326), $${paramCount+1})`);
      params.push(lat, lng, radius * 1000); // Convert km to meters
      paramCount++;
    } else if (vendorLocation.rows.length > 0) {
      paramCount++;
      whereConditions.push(`ST_DWithin(f.location, (SELECT location FROM vendors WHERE user_id = $${paramCount}), $${paramCount+1})`);
      params.push(req.user.id, radius * 1000);
      paramCount++;
    }

    const products = await query(
      `SELECT pl.*, p.name as product_name, p.category, p.unit,
              f.name as farmer_name, f.village, f.district, f.hygiene_rating, f.hygiene_badge,
              ST_Distance(f.location, v.location) as distance,
              COALESCE(avg_rating.rating, 5.0) as farmer_rating
       FROM product_listings pl
       JOIN products p ON pl.product_id = p.id
       JOIN farmers f ON pl.farmer_id = f.id
       LEFT JOIN vendors v ON v.user_id = $${paramCount + 1}
       LEFT JOIN (
         SELECT r.rated_user, AVG(r.rating) as rating
         FROM ratings r
         JOIN users u ON r.rated_user = u.id
         WHERE u.user_type = 'farmer'
         GROUP BY r.rated_user
       ) avg_rating ON avg_rating.rated_user = f.user_id
       WHERE ${whereConditions.join(' AND ')}
       ORDER BY distance, pl.created_at DESC
       LIMIT $${paramCount + 2} OFFSET $${paramCount + 3}`,
      [...params, req.user.id, limit, offset]
    );

    // Get total count for pagination
    const totalResult = await query(
      `SELECT COUNT(*) as total 
       FROM product_listings pl
       JOIN products p ON pl.product_id = p.id
       JOIN farmers f ON pl.farmer_id = f.id
       LEFT JOIN vendors v ON v.user_id = $${paramCount + 1}
       WHERE ${whereConditions.join(' AND ')}`,
      [...params, req.user.id]
    );

    res.json({
      success: true,
      data: {
        products: products.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(totalResult.rows[0].total),
          pages: Math.ceil(totalResult.rows[0].total / limit)
        }
      }
    });

  } catch (error) {
    logger.error('Browse products error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products'
    });
  }
});

// Get product details
router.get('/products/:listingId', authenticate, authorize('vendor'), async (req, res) => {
  try {
    const { listingId } = req.params;

    const product = await query(
      `SELECT pl.*, p.name as product_name, p.category, p.unit,
              f.name as farmer_name, f.village, f.district, f.state, f.hygiene_rating, f.hygiene_badge,
              f.total_deliveries, f.qr_code as farmer_qr,
              ST_X(f.location::geometry) as farmer_longitude,
              ST_Y(f.location::geometry) as farmer_latitude,
              COALESCE(avg_rating.rating, 5.0) as farmer_rating,
              COALESCE(avg_rating.total_ratings, 0) as total_ratings
       FROM product_listings pl
       JOIN products p ON pl.product_id = p.id
       JOIN farmers f ON pl.farmer_id = f.id
       LEFT JOIN (
         SELECT r.rated_user, AVG(r.rating) as rating, COUNT(r.id) as total_ratings
         FROM ratings r
         JOIN users u ON r.rated_user = u.id
         WHERE u.user_type = 'farmer'
         GROUP BY r.rated_user
       ) avg_rating ON avg_rating.rated_user = f.user_id
       WHERE pl.id = $1 AND pl.status = 'available'`,
      [listingId]
    );

    if (product.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Product not found or not available'
      });
    }

    // Get recent reviews for this farmer
    const reviews = await query(
      `SELECT r.rating, r.hygiene_rating, r.quality_rating, r.comments, r.created_at,
              v.business_name as reviewer_name
       FROM ratings r
       JOIN orders o ON r.order_id = o.id
       JOIN vendors v ON o.vendor_id = v.id
       WHERE r.rated_user = (SELECT user_id FROM farmers WHERE id = $1)
       ORDER BY r.created_at DESC
       LIMIT 5`,
      [product.rows[0].farmer_id]
    );

    res.json({
      success: true,
      data: {
        product: product.rows[0],
        reviews: reviews.rows
      }
    });

  } catch (error) {
    logger.error('Get product details error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch product details'
    });
  }
});

// Place order
router.post('/orders', authenticate, authorize('vendor'), async (req, res) => {
  try {
    const schema = Joi.object({
      product_listing_id: Joi.string().uuid().required(),
      quantity: Joi.number().positive().required(),
      special_instructions: Joi.string().max(500).optional(),
      delivery_address: Joi.object({
        address: Joi.string().required(),
        latitude: Joi.number().required(),
        longitude: Joi.number().required()
      }).required()
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const vendorId = await query(
      'SELECT id FROM vendors WHERE user_id = $1',
      [req.user.id]
    );

    if (vendorId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vendor profile not found'
      });
    }

    const vendorUUID = vendorId.rows[0].id;

    // Create order in transaction
    const order = await transaction(async (client) => {
      // Get product listing details
      const listing = await client.query(
        `SELECT pl.*, f.id as farmer_id, f.user_id as farmer_user_id,
                ST_X(f.location::geometry) as farmer_longitude,
                ST_Y(f.location::geometry) as farmer_latitude
         FROM product_listings pl
         JOIN farmers f ON pl.farmer_id = f.id
         WHERE pl.id = $1 AND pl.status = 'available'`,
        [value.product_listing_id]
      );

      if (listing.rows.length === 0) {
        throw new Error('Product not available');
      }

      const productListing = listing.rows[0];

      // Check if enough quantity is available
      if (value.quantity > productListing.quantity) {
        throw new Error('Insufficient quantity available');
      }

      // Generate order number
      const orderNumber = `ORD${Date.now()}${Math.floor(Math.random() * 1000)}`;

      // Calculate amounts
      const unitPrice = productListing.price_per_unit;
      const totalAmount = unitPrice * value.quantity;
      const deliveryFee = 8.00; // Fixed delivery fee as per spec
      const pickupMargin = 3.00; // Fixed pickup margin as per spec

      // Create order
      const orderInsert = await client.query(
        `INSERT INTO orders 
         (order_number, vendor_id, farmer_id, product_listing_id, quantity, unit_price, total_amount, 
          delivery_fee, pickup_margin, pickup_location, delivery_location, special_instructions, qr_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 
                 ST_SetSRID(ST_MakePoint($10, $11), 4326),
                 ST_SetSRID(ST_MakePoint($12, $13), 4326),
                 $14, $15)
         RETURNING *`,
        [
          orderNumber,
          vendorUUID,
          productListing.farmer_id,
          value.product_listing_id,
          value.quantity,
          unitPrice,
          totalAmount,
          deliveryFee,
          pickupMargin,
          productListing.farmer_longitude,
          productListing.farmer_latitude,
          value.delivery_address.longitude,
          value.delivery_address.latitude,
          value.special_instructions,
          `order:${orderNumber}`
        ]
      );

      // Update product listing quantity
      await client.query(
        'UPDATE product_listings SET quantity = quantity - $1 WHERE id = $2',
        [value.quantity, value.product_listing_id]
      );

      // If listing quantity becomes 0, mark as sold
      await client.query(
        'UPDATE product_listings SET status = $1 WHERE id = $2 AND quantity <= 0',
        ['sold', value.product_listing_id]
      );

      return orderInsert.rows[0];
    });

    // Send notifications
    const farmerUserId = await query(
      'SELECT user_id FROM farmers WHERE id = $1',
      [order.farmer_id]
    );

    if (farmerUserId.rows.length > 0) {
      await sendNotification(
        farmerUserId.rows[0].user_id,
        `नया ऑर्डर #${order.order_number} - ${value.quantity}kg। कृपया कन्फर्म करें।`,
        'new_order',
        'urgent'
      );
    }

    // Send confirmation to vendor
    await sendNotification(
      req.user.id,
      `Order #${order.order_number} placed successfully. Waiting for farmer confirmation.`,
      'order_placed'
    );

    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      data: order
    });

  } catch (error) {
    logger.error('Place order error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to place order'
    });
  }
});

// Get vendor's orders
router.get('/orders', authenticate, authorize('vendor'), async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    const vendorId = await query(
      'SELECT id FROM vendors WHERE user_id = $1',
      [req.user.id]
    );

    if (vendorId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vendor profile not found'
      });
    }

    const vendorUUID = vendorId.rows[0].id;

    let whereClause = 'WHERE o.vendor_id = $1';
    let params = [vendorUUID];

    if (status) {
      whereClause += ' AND o.status = $2';
      params.push(status);
    }

    const orders = await query(
      `SELECT o.*, p.name as product_name, p.unit,
              f.name as farmer_name, f.village, f.hygiene_badge,
              pl.quality_grade,
              a.name as agent_name, a.vehicle_number,
              r.rating as vendor_rating, r.comments as vendor_comments
       FROM orders o
       JOIN product_listings pl ON o.product_listing_id = pl.id
       JOIN products p ON pl.product_id = p.id
       JOIN farmers f ON o.farmer_id = f.id
       LEFT JOIN route_orders ro ON o.id = ro.order_id
       LEFT JOIN routes rt ON ro.route_id = rt.id
       LEFT JOIN agents a ON rt.agent_id = a.id
       LEFT JOIN ratings r ON o.id = r.order_id AND r.rated_by = (SELECT user_id FROM vendors WHERE id = o.vendor_id)
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
    logger.error('Get vendor orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch orders'
    });
  }
});

// Get order details
router.get('/orders/:orderId', authenticate, authorize('vendor'), async (req, res) => {
  try {
    const { orderId } = req.params;

    const vendorId = await query(
      'SELECT id FROM vendors WHERE user_id = $1',
      [req.user.id]
    );

    if (vendorId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vendor profile not found'
      });
    }

    const vendorUUID = vendorId.rows[0].id;

    const order = await query(
      `SELECT o.*, p.name as product_name, p.unit, p.category,
              f.name as farmer_name, f.village, f.district, f.hygiene_rating, f.hygiene_badge,
              f.phone_number as farmer_phone,
              pl.quality_grade, pl.harvest_date, pl.images as product_images,
              a.name as agent_name, a.vehicle_number, a.phone_number as agent_phone,
              rt.route_name, rt.estimated_duration,
              ro.pickup_eta, ro.delivery_eta, ro.actual_pickup_time, ro.actual_delivery_time,
              ST_X(o.pickup_location::geometry) as pickup_longitude,
              ST_Y(o.pickup_location::geometry) as pickup_latitude,
              ST_X(o.delivery_location::geometry) as delivery_longitude,
              ST_Y(o.delivery_location::geometry) as delivery_latitude
       FROM orders o
       JOIN product_listings pl ON o.product_listing_id = pl.id
       JOIN products p ON pl.product_id = p.id
       JOIN farmers f ON o.farmer_id = f.id
       JOIN users uf ON f.user_id = uf.id
       LEFT JOIN route_orders ro ON o.id = ro.order_id
       LEFT JOIN routes rt ON ro.route_id = rt.id
       LEFT JOIN agents a ON rt.agent_id = a.id
       LEFT JOIN users ua ON a.user_id = ua.id
       WHERE o.id = $1 AND o.vendor_id = $2`,
      [orderId, vendorUUID]
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

// Cancel order (only if not confirmed by farmer)
router.post('/orders/:orderId/cancel', authenticate, authorize('vendor'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body;

    const vendorId = await query(
      'SELECT id FROM vendors WHERE user_id = $1',
      [req.user.id]
    );

    if (vendorId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vendor profile not found'
      });
    }

    const vendorUUID = vendorId.rows[0].id;

    const result = await transaction(async (client) => {
      // Update order status
      const orderUpdate = await client.query(
        'UPDATE orders SET status = $1 WHERE id = $2 AND vendor_id = $3 AND status = $4 RETURNING *',
        ['cancelled', orderId, vendorUUID, 'placed']
      );

      if (orderUpdate.rows.length === 0) {
        throw new Error('Order not found or cannot be cancelled');
      }

      const order = orderUpdate.rows[0];

      // Restore product listing quantity
      await client.query(
        'UPDATE product_listings SET quantity = quantity + $1, status = $2 WHERE id = $3',
        [order.quantity, 'available', order.product_listing_id]
      );

      // Get farmer details for notification
      const farmer = await client.query(
        'SELECT user_id FROM farmers WHERE id = $1',
        [order.farmer_id]
      );

      // Send notification to farmer
      if (farmer.rows.length > 0) {
        await sendNotification(
          farmer.rows[0].user_id,
          `ऑर्डर #${order.order_number} कैंसल हो गया है। कारण: ${reason || 'No reason provided'}`,
          'order_cancelled'
        );
      }

      return order;
    });

    res.json({
      success: true,
      message: 'Order cancelled successfully',
      data: result
    });

  } catch (error) {
    logger.error('Cancel order error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to cancel order'
    });
  }
});

// Get nearby farmers
router.get('/nearby-farmers', authenticate, authorize('vendor'), async (req, res) => {
  try {
    const { radius = 50, category } = req.query;

    const vendorLocation = await query(
      'SELECT location FROM vendors WHERE user_id = $1',
      [req.user.id]
    );

    if (vendorLocation.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vendor profile not found'
      });
    }

    let categoryFilter = '';
    let params = [req.user.id, radius * 1000]; // Convert km to meters

    if (category) {
      categoryFilter = 'AND p.category = $3';
      params.push(category);
    }

    const farmers = await query(
      `SELECT f.*, 
              ST_Distance(f.location, v.location) as distance,
              COUNT(DISTINCT pl.id) as available_products,
              COUNT(DISTINCT CASE WHEN p.category = $${params.length + 1} THEN pl.id END) as category_products,
              COALESCE(avg_rating.rating, 5.0) as farmer_rating,
              COALESCE(avg_rating.total_ratings, 0) as total_ratings
       FROM farmers f
       JOIN vendors v ON v.user_id = $1
       LEFT JOIN product_listings pl ON f.id = pl.farmer_id AND pl.status = 'available'
       LEFT JOIN products p ON pl.product_id = p.id
       LEFT JOIN (
         SELECT r.rated_user, AVG(r.rating) as rating, COUNT(r.id) as total_ratings
         FROM ratings r
         JOIN users u ON r.rated_user = u.id
         WHERE u.user_type = 'farmer'
         GROUP BY r.rated_user
       ) avg_rating ON avg_rating.rated_user = f.user_id
       WHERE ST_DWithin(f.location, v.location, $2) ${categoryFilter}
       GROUP BY f.id, f.name, f.village, f.hygiene_rating, f.hygiene_badge, f.location, v.location, avg_rating.rating, avg_rating.total_ratings
       HAVING COUNT(DISTINCT pl.id) > 0
       ORDER BY distance
       LIMIT 20`,
      [...params, category || '']
    );

    res.json({
      success: true,
      data: farmers.rows
    });

  } catch (error) {
    logger.error('Get nearby farmers error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch nearby farmers'
    });
  }
});

// Get vendor's spending analytics
router.get('/analytics', authenticate, authorize('vendor'), async (req, res) => {
  try {
    const { period = '30', start_date, end_date } = req.query;

    const vendorId = await query(
      'SELECT id FROM vendors WHERE user_id = $1',
      [req.user.id]
    );

    if (vendorId.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Vendor profile not found'
      });
    }

    const vendorUUID = vendorId.rows[0].id;

    let dateFilter = '';
    let params = [vendorUUID];

    if (start_date && end_date) {
      dateFilter = 'AND o.created_at BETWEEN $2 AND $3';
      params.push(start_date, end_date);
    } else {
      dateFilter = 'AND o.created_at >= CURRENT_DATE - INTERVAL $2 DAY';
      params.push(`${period} days`);
    }

    const [spending, categoryBreakdown, topFarmers, monthlyTrend] = await Promise.all([
      // Total spending summary
      query(
        `SELECT 
           COUNT(*) as total_orders,
           COALESCE(SUM(total_amount), 0) as total_spent,
           COALESCE(SUM(delivery_fee), 0) as total_delivery_fees,
           COALESCE(AVG(total_amount), 0) as avg_order_value,
           COUNT(CASE WHEN status = 'delivered' THEN 1 END) as completed_orders
         FROM orders o
         WHERE vendor_id = $1 ${dateFilter}`,
        params
      ),
      
      // Category-wise breakdown
      query(
        `SELECT p.category, 
                COUNT(*) as order_count,
                COALESCE(SUM(o.total_amount), 0) as total_spent,
                COALESCE(SUM(o.quantity), 0) as total_quantity
         FROM orders o
         JOIN product_listings pl ON o.product_listing_id = pl.id
         JOIN products p ON pl.product_id = p.id
         WHERE o.vendor_id = $1 ${dateFilter}
         GROUP BY p.category
         ORDER BY total_spent DESC`,
        params
      ),
      
      // Top farmers by spending
      query(
        `SELECT f.name, f.village, f.hygiene_rating,
                COUNT(*) as order_count,
                COALESCE(SUM(o.total_amount), 0) as total_spent
         FROM orders o
         JOIN farmers f ON o.farmer_id = f.id
         WHERE o.vendor_id = $1 ${dateFilter}
         GROUP BY f.id, f.name, f.village, f.hygiene_rating
         ORDER BY total_spent DESC
         LIMIT 10`,
        params
      ),
      
      // Monthly spending trend
      query(
        `SELECT DATE_TRUNC('month', o.created_at) as month,
                COUNT(*) as order_count,
                COALESCE(SUM(o.total_amount), 0) as total_spent
         FROM orders o
         WHERE o.vendor_id = $1 AND o.created_at >= CURRENT_DATE - INTERVAL '12 months'
         GROUP BY DATE_TRUNC('month', o.created_at)
         ORDER BY month`,
        [vendorUUID]
      )
    ]);

    res.json({
      success: true,
      data: {
        summary: spending.rows[0],
        category_breakdown: categoryBreakdown.rows,
        top_farmers: topFarmers.rows,
        monthly_trend: monthlyTrend.rows
      }
    });

  } catch (error) {
    logger.error('Get vendor analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch analytics'
    });
  }
});

module.exports = router;