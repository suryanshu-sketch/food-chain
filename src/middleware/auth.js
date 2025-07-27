const jwt = require('jsonwebtoken');
const { query } = require('../database/connection');
const logger = require('../utils/logger');

// Verify JWT token
const authenticate = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Get user details from database
    const result = await query(
      'SELECT u.*, f.name as farmer_name, v.business_name, a.name as agent_name FROM users u LEFT JOIN farmers f ON u.id = f.user_id LEFT JOIN vendors v ON u.id = v.user_id LEFT JOIN agents a ON u.id = a.user_id WHERE u.id = $1 AND u.is_active = true',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token. User not found.'
      });
    }

    req.user = result.rows[0];
    next();
  } catch (error) {
    logger.error('Authentication error:', error);
    return res.status(401).json({
      success: false,
      message: 'Invalid token.'
    });
  }
};

// Check if user has required role
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Please login first.'
      });
    }

    if (!roles.includes(req.user.user_type)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.'
      });
    }

    next();
  };
};

// Optional authentication (for public endpoints that can benefit from user context)
const optionalAuth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const result = await query(
        'SELECT u.*, f.name as farmer_name, v.business_name, a.name as agent_name FROM users u LEFT JOIN farmers f ON u.id = f.user_id LEFT JOIN vendors v ON u.id = v.user_id LEFT JOIN agents a ON u.id = a.user_id WHERE u.id = $1 AND u.is_active = true',
        [decoded.userId]
      );
      
      if (result.rows.length > 0) {
        req.user = result.rows[0];
      }
    }
    
    next();
  } catch (error) {
    // Ignore auth errors for optional auth
    next();
  }
};

module.exports = {
  authenticate,
  authorize,
  optionalAuth
};