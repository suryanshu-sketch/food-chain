const express = require('express');
const { query } = require('../database/connection');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// Get unified dashboard data based on user type
router.get('/', authenticate, async (req, res) => {
  try {
    let dashboardData;

    switch (req.user.user_type) {
      case 'farmer':
        dashboardData = await getFarmerDashboard(req.user.id);
        break;
      case 'vendor':
        dashboardData = await getVendorDashboard(req.user.id);
        break;
      case 'agent':
        dashboardData = await getAgentDashboard(req.user.id);
        break;
      case 'admin':
        dashboardData = await getAdminDashboard();
        break;
      default:
        return res.status(403).json({
          success: false,
          message: 'Invalid user type'
        });
    }

    res.json({
      success: true,
      data: dashboardData
    });

  } catch (error) {
    logger.error('Dashboard error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard data'
    });
  }
});

// Get farmer dashboard data
const getFarmerDashboard = async (userId) => {
  const farmerId = await query(
    'SELECT id FROM farmers WHERE user_id = $1',
    [userId]
  );

  if (farmerId.rows.length === 0) {
    throw new Error('Farmer profile not found');
  }

  const farmerUUID = farmerId.rows[0].id;

  const [
    profile,
    stats,
    recentOrders,
    earnings,
    ratings,
    activeListings
  ] = await Promise.all([
    // Farmer profile
    query(`
      SELECT f.*, u.phone_number,
             ST_X(f.location::geometry) as longitude,
             ST_Y(f.location::geometry) as latitude
      FROM farmers f
      JOIN users u ON f.user_id = u.id
      WHERE f.id = $1
    `, [farmerUUID]),

    // Statistics
    query(`
      SELECT 
        COUNT(DISTINCT pl.id) as total_listings,
        COUNT(DISTINCT CASE WHEN pl.status = 'available' THEN pl.id END) as active_listings,
        COUNT(DISTINCT o.id) as total_orders,
        COUNT(DISTINCT CASE WHEN o.status = 'delivered' THEN o.id END) as completed_orders,
        COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN o.total_amount ELSE 0 END), 0) as total_earnings
      FROM product_listings pl
      LEFT JOIN orders o ON pl.id = o.product_listing_id
      WHERE pl.farmer_id = $1
    `, [farmerUUID]),

    // Recent orders
    query(`
      SELECT o.*, p.name as product_name, v.business_name,
             r.rating, r.comments
      FROM orders o
      JOIN product_listings pl ON o.product_listing_id = pl.id
      JOIN products p ON pl.product_id = p.id
      JOIN vendors v ON o.vendor_id = v.id
      LEFT JOIN ratings r ON o.id = r.order_id AND r.rated_user = $2
      WHERE o.farmer_id = $1
      ORDER BY o.created_at DESC
      LIMIT 5
    `, [farmerUUID, userId]),

    // Earnings breakdown
    query(`
      SELECT 
        DATE_TRUNC('month', o.created_at) as month,
        COUNT(*) as order_count,
        COALESCE(SUM(o.total_amount), 0) as monthly_earnings
      FROM orders o
      WHERE o.farmer_id = $1 AND o.status = 'delivered'
        AND o.created_at >= CURRENT_DATE - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', o.created_at)
      ORDER BY month
    `, [farmerUUID]),

    // Ratings summary
    query(`
      SELECT 
        COUNT(*) as total_ratings,
        COALESCE(AVG(rating), 0) as avg_rating,
        COALESCE(AVG(hygiene_rating), 0) as avg_hygiene,
        COALESCE(AVG(quality_rating), 0) as avg_quality
      FROM ratings
      WHERE rated_user = $1
    `, [userId]),

    // Active listings
    query(`
      SELECT pl.*, p.name as product_name, p.category
      FROM product_listings pl
      JOIN products p ON pl.product_id = p.id
      WHERE pl.farmer_id = $1 AND pl.status = 'available'
      ORDER BY pl.created_at DESC
      LIMIT 5
    `, [farmerUUID])
  ]);

  return {
    user_type: 'farmer',
    profile: profile.rows[0],
    statistics: stats.rows[0],
    recent_orders: recentOrders.rows,
    earnings_trend: earnings.rows,
    ratings_summary: ratings.rows[0],
    active_listings: activeListings.rows
  };
};

// Get vendor dashboard data
const getVendorDashboard = async (userId) => {
  const vendorId = await query(
    'SELECT id FROM vendors WHERE user_id = $1',
    [userId]
  );

  if (vendorId.rows.length === 0) {
    throw new Error('Vendor profile not found');
  }

  const vendorUUID = vendorId.rows[0].id;

  const [
    profile,
    stats,
    recentOrders,
    spending,
    nearbyFarmers,
    favoriteProducts
  ] = await Promise.all([
    // Vendor profile
    query(`
      SELECT v.*, u.phone_number,
             ST_X(v.location::geometry) as longitude,
             ST_Y(v.location::geometry) as latitude
      FROM vendors v
      JOIN users u ON v.user_id = u.id
      WHERE v.id = $1
    `, [vendorUUID]),

    // Statistics
    query(`
      SELECT 
        COUNT(*) as total_orders,
        COUNT(CASE WHEN status = 'delivered' THEN 1 END) as completed_orders,
        COUNT(CASE WHEN status IN ('placed', 'confirmed', 'picked', 'in_transit') THEN 1 END) as pending_orders,
        COALESCE(SUM(CASE WHEN status = 'delivered' THEN total_amount + delivery_fee ELSE 0 END), 0) as total_spent
      FROM orders
      WHERE vendor_id = $1
    `, [vendorUUID]),

    // Recent orders
    query(`
      SELECT o.*, p.name as product_name, f.name as farmer_name, f.village,
             pl.quality_grade, r.rating, r.comments
      FROM orders o
      JOIN product_listings pl ON o.product_listing_id = pl.id
      JOIN products p ON pl.product_id = p.id
      JOIN farmers f ON o.farmer_id = f.id
      LEFT JOIN ratings r ON o.id = r.order_id AND r.rated_by = $2
      WHERE o.vendor_id = $1
      ORDER BY o.created_at DESC
      LIMIT 5
    `, [vendorUUID, userId]),

    // Spending breakdown
    query(`
      SELECT 
        DATE_TRUNC('month', o.created_at) as month,
        COUNT(*) as order_count,
        COALESCE(SUM(o.total_amount + o.delivery_fee), 0) as monthly_spending
      FROM orders o
      WHERE o.vendor_id = $1 AND o.status = 'delivered'
        AND o.created_at >= CURRENT_DATE - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', o.created_at)
      ORDER BY month
    `, [vendorUUID]),

    // Nearby farmers with available products
    query(`
      SELECT f.*, COUNT(pl.id) as available_products,
             ST_Distance(f.location, v.location) as distance
      FROM farmers f
      JOIN vendors v ON v.id = $1
      LEFT JOIN product_listings pl ON f.id = pl.farmer_id AND pl.status = 'available'
      WHERE ST_DWithin(f.location, v.location, 50000)
      GROUP BY f.id, f.name, f.village, f.hygiene_rating, f.location, v.location
      HAVING COUNT(pl.id) > 0
      ORDER BY distance
      LIMIT 10
    `, [vendorUUID]),

    // Favorite products (most ordered)
    query(`
      SELECT p.name, p.category, p.unit,
             COUNT(*) as order_count,
             COALESCE(SUM(o.quantity), 0) as total_quantity,
             COALESCE(SUM(o.total_amount), 0) as total_spent
      FROM orders o
      JOIN product_listings pl ON o.product_listing_id = pl.id
      JOIN products p ON pl.product_id = p.id
      WHERE o.vendor_id = $1 AND o.status = 'delivered'
      GROUP BY p.id, p.name, p.category, p.unit
      ORDER BY order_count DESC
      LIMIT 5
    `, [vendorUUID])
  ]);

  return {
    user_type: 'vendor',
    profile: profile.rows[0],
    statistics: stats.rows[0],
    recent_orders: recentOrders.rows,
    spending_trend: spending.rows,
    nearby_farmers: nearbyFarmers.rows,
    favorite_products: favoriteProducts.rows
  };
};

// Get agent dashboard data
const getAgentDashboard = async (userId) => {
  const agentId = await query(
    'SELECT id FROM agents WHERE user_id = $1',
    [userId]
  );

  if (agentId.rows.length === 0) {
    throw new Error('Agent profile not found');
  }

  const agentUUID = agentId.rows[0].id;

  const [
    profile,
    stats,
    activeRoute,
    earnings,
    performance,
    recentRatings
  ] = await Promise.all([
    // Agent profile
    query(`
      SELECT a.*, u.phone_number,
             ST_X(a.current_location::geometry) as longitude,
             ST_Y(a.current_location::geometry) as latitude
      FROM agents a
      JOIN users u ON a.user_id = u.id
      WHERE a.id = $1
    `, [agentUUID]),

    // Statistics
    query(`
      SELECT 
        COUNT(DISTINCT r.id) as total_routes,
        COUNT(DISTINCT CASE WHEN r.status = 'completed' THEN r.id END) as completed_routes,
        COUNT(DISTINCT ro.id) as total_pickups,
        COUNT(DISTINCT CASE WHEN ro.actual_pickup_time IS NOT NULL THEN ro.id END) as completed_pickups,
        COALESCE(SUM(o.pickup_margin), 0) as total_earnings
      FROM routes r
      LEFT JOIN route_orders ro ON r.id = ro.route_id
      LEFT JOIN orders o ON ro.order_id = o.id
      WHERE r.agent_id = $1
    `, [agentUUID]),

    // Active route
    query(`
      SELECT r.*, COUNT(ro.id) as total_orders,
             COUNT(CASE WHEN ro.actual_pickup_time IS NOT NULL THEN 1 END) as completed_pickups
      FROM routes r
      LEFT JOIN route_orders ro ON r.id = ro.route_id
      WHERE r.agent_id = $1 AND r.status = 'active'
      GROUP BY r.id
      ORDER BY r.created_at DESC
      LIMIT 1
    `, [agentUUID]),

    // Earnings trend
    query(`
      SELECT 
        DATE_TRUNC('month', r.route_date) as month,
        COUNT(DISTINCT r.id) as route_count,
        COALESCE(SUM(o.pickup_margin), 0) as monthly_earnings
      FROM routes r
      LEFT JOIN route_orders ro ON r.id = ro.route_id
      LEFT JOIN orders o ON ro.order_id = o.id
      WHERE r.agent_id = $1 AND ro.actual_pickup_time IS NOT NULL
        AND r.route_date >= CURRENT_DATE - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', r.route_date)
      ORDER BY month
    `, [agentUUID]),

    // Performance metrics
    query(`
      SELECT 
        COUNT(ro.id) as total_orders,
        COUNT(CASE WHEN ro.actual_pickup_time IS NOT NULL THEN 1 END) as successful_pickups,
        COALESCE(AVG(EXTRACT(EPOCH FROM (ro.actual_pickup_time - ro.pickup_eta))/60), 0) as avg_delay_minutes,
        COALESCE(AVG(r.rating), 0) as avg_rating
      FROM routes rt
      LEFT JOIN route_orders ro ON rt.id = ro.route_id
      LEFT JOIN ratings r ON ro.order_id = r.order_id
      WHERE rt.agent_id = $1 AND rt.status = 'completed'
    `, [agentUUID]),

    // Recent ratings
    query(`
      SELECT r.rating, r.comments, r.created_at, o.order_number
      FROM ratings r
      JOIN orders o ON r.order_id = o.id
      JOIN route_orders ro ON o.id = ro.order_id
      JOIN routes rt ON ro.route_id = rt.id
      WHERE rt.agent_id = $1
      ORDER BY r.created_at DESC
      LIMIT 5
    `, [agentUUID])
  ]);

  return {
    user_type: 'agent',
    profile: profile.rows[0],
    statistics: stats.rows[0],
    active_route: activeRoute.rows[0] || null,
    earnings_trend: earnings.rows,
    performance_metrics: performance.rows[0],
    recent_ratings: recentRatings.rows
  };
};

// Get admin dashboard data
const getAdminDashboard = async () => {
  const [
    systemStats,
    recentActivity,
    performanceMetrics,
    geographicDistribution,
    alertsAndIssues
  ] = await Promise.all([
    // System statistics
    query(`
      SELECT 
        (SELECT COUNT(*) FROM users WHERE is_active = true) as active_users,
        (SELECT COUNT(*) FROM orders WHERE created_at >= CURRENT_DATE) as today_orders,
        (SELECT COUNT(*) FROM routes WHERE status = 'active') as active_routes,
        (SELECT COUNT(*) FROM disputes WHERE status = 'open') as open_disputes,
        (SELECT COALESCE(SUM(total_amount + delivery_fee), 0) FROM orders WHERE status = 'delivered' AND created_at >= CURRENT_DATE - INTERVAL '30 days') as monthly_revenue
    `),

    // Recent activity
    query(`
      SELECT 'order' as type, order_number as reference, status, created_at
      FROM orders 
      WHERE created_at >= CURRENT_DATE - INTERVAL '24 hours'
      UNION ALL
      SELECT 'user' as type, phone_number as reference, 
             CASE WHEN is_active THEN 'registered' ELSE 'suspended' END as status, 
             created_at
      FROM users 
      WHERE created_at >= CURRENT_DATE - INTERVAL '24 hours'
      ORDER BY created_at DESC
      LIMIT 20
    `),

    // Performance metrics
    query(`
      SELECT 
        COUNT(CASE WHEN status = 'delivered' THEN 1 END) * 100.0 / COUNT(*) as completion_rate,
        COUNT(CASE WHEN status = 'disputed' THEN 1 END) * 100.0 / COUNT(*) as dispute_rate,
        COALESCE(AVG(EXTRACT(EPOCH FROM (delivery_time - created_at))/3600), 0) as avg_delivery_hours,
        COALESCE(AVG(r.rating), 0) as avg_rating
      FROM orders o
      LEFT JOIN ratings r ON o.id = r.order_id
      WHERE o.created_at >= CURRENT_DATE - INTERVAL '30 days'
    `),

    // Geographic distribution
    query(`
      SELECT f.state, COUNT(*) as farmer_count,
             COUNT(DISTINCT o.id) as order_count
      FROM farmers f
      LEFT JOIN orders o ON f.id = o.farmer_id AND o.created_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY f.state
      ORDER BY farmer_count DESC
      LIMIT 10
    `),

    // Alerts and issues
    query(`
      SELECT 
        (SELECT COUNT(*) FROM farmers WHERE hygiene_badge = 'red') as suspended_farmers,
        (SELECT COUNT(*) FROM disputes WHERE status = 'open' AND created_at >= CURRENT_DATE - INTERVAL '7 days') as new_disputes,
        (SELECT COUNT(*) FROM routes WHERE status = 'cancelled' AND route_date >= CURRENT_DATE - INTERVAL '7 days') as cancelled_routes,
        (SELECT COUNT(*) FROM orders WHERE status IN ('placed', 'confirmed') AND created_at <= CURRENT_DATE - INTERVAL '24 hours') as delayed_orders
    `)
  ]);

  return {
    user_type: 'admin',
    system_statistics: systemStats.rows[0],
    recent_activity: recentActivity.rows,
    performance_metrics: performanceMetrics.rows[0],
    geographic_distribution: geographicDistribution.rows,
    alerts_and_issues: alertsAndIssues.rows[0]
  };
};

// Get real-time metrics
router.get('/realtime', authenticate, async (req, res) => {
  try {
    const metrics = await query(`
      SELECT 
        (SELECT COUNT(*) FROM orders WHERE status = 'in_transit') as orders_in_transit,
        (SELECT COUNT(*) FROM routes WHERE status = 'active') as active_routes,
        (SELECT COUNT(*) FROM agents WHERE is_available = false) as busy_agents,
        (SELECT COUNT(*) FROM users WHERE created_at >= CURRENT_DATE) as new_users_today,
        (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE status = 'delivered' AND delivery_time >= CURRENT_DATE) as today_revenue
    `);

    res.json({
      success: true,
      data: metrics.rows[0],
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error('Real-time metrics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch real-time metrics'
    });
  }
});

// Get notifications for user
router.get('/notifications', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 20, is_read } = req.query;
    const offset = (page - 1) * limit;

    let whereConditions = ['user_id = $1'];
    let params = [req.user.id];

    if (is_read !== undefined) {
      whereConditions.push('is_read = $2');
      params.push(is_read === 'true');
    }

    const notifications = await query(`
      SELECT * FROM notifications
      WHERE ${whereConditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    // Get unread count
    const unreadCount = await query(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND is_read = false',
      [req.user.id]
    );

    res.json({
      success: true,
      data: {
        notifications: notifications.rows,
        unread_count: parseInt(unreadCount.rows[0].count),
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit)
        }
      }
    });

  } catch (error) {
    logger.error('Get notifications error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch notifications'
    });
  }
});

// Mark notification as read
router.put('/notifications/:notificationId/read', authenticate, async (req, res) => {
  try {
    const { notificationId } = req.params;

    const result = await query(
      'UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2 RETURNING *',
      [notificationId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    res.json({
      success: true,
      message: 'Notification marked as read',
      data: result.rows[0]
    });

  } catch (error) {
    logger.error('Mark notification read error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark notification as read'
    });
  }
});

module.exports = router;