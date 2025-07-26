const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const { query, transaction } = require('../database/connection');
const { authenticate } = require('../middleware/auth');
const { sendSMS, sendWhatsApp } = require('../services/communications');
const logger = require('../utils/logger');
const QRCode = require('qrcode');

const router = express.Router();

// Generate OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Generate JWT token
const generateToken = (userId, userType) => {
  return jwt.sign(
    { userId, userType },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
};

// Send OTP for phone verification
router.post('/send-otp', async (req, res) => {
  try {
    const schema = Joi.object({
      phone_number: Joi.string().pattern(/^[6-9]\d{9}$/).required(),
      user_type: Joi.string().valid('farmer', 'vendor', 'agent').required()
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const { phone_number, user_type } = value;
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store OTP in database (you might want to use Redis for this)
    await query(
      'INSERT INTO otp_verifications (phone_number, otp, user_type, expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT (phone_number) DO UPDATE SET otp = $2, expires_at = $4, created_at = CURRENT_TIMESTAMP',
      [phone_number, otp, user_type, otpExpiry]
    );

    // Send OTP via SMS
    const message = `आपका OTP: ${otp}। कृपया 10 मिनट में दर्ज करें। - AgriSupply`;
    await sendSMS(phone_number, message);

    // Also send via WhatsApp if available
    try {
      await sendWhatsApp(phone_number, `Your OTP: ${otp}. Please enter within 10 minutes.`);
    } catch (whatsappError) {
      logger.warn('WhatsApp OTP failed, SMS sent:', whatsappError);
    }

    res.json({
      success: true,
      message: 'OTP sent successfully',
      data: {
        phone_number,
        expires_in: 600 // 10 minutes in seconds
      }
    });

  } catch (error) {
    logger.error('Send OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send OTP'
    });
  }
});

// Verify OTP and register/login user
router.post('/verify-otp', async (req, res) => {
  try {
    const schema = Joi.object({
      phone_number: Joi.string().pattern(/^[6-9]\d{9}$/).required(),
      otp: Joi.string().length(6).required(),
      user_data: Joi.object().optional()
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const { phone_number, otp, user_data } = value;

    // Verify OTP
    const otpResult = await query(
      'SELECT * FROM otp_verifications WHERE phone_number = $1 AND otp = $2 AND expires_at > CURRENT_TIMESTAMP',
      [phone_number, otp]
    );

    if (otpResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP'
      });
    }

    const otpRecord = otpResult.rows[0];

    // Check if user already exists
    const userResult = await query(
      'SELECT * FROM users WHERE phone_number = $1',
      [phone_number]
    );

    let user;
    let isNewUser = false;

    if (userResult.rows.length === 0) {
      // New user registration
      if (!user_data) {
        return res.status(400).json({
          success: false,
          message: 'User data required for registration'
        });
      }

      isNewUser = true;
      user = await transaction(async (client) => {
        // Create base user
        const userInsert = await client.query(
          'INSERT INTO users (phone_number, user_type) VALUES ($1, $2) RETURNING *',
          [phone_number, otpRecord.user_type]
        );
        const newUser = userInsert.rows[0];

        // Create specific user type record
        let specificUserData;
        if (otpRecord.user_type === 'farmer') {
          const qrCode = await QRCode.toDataURL(`farmer:${newUser.id}`);
          const farmerInsert = await client.query(
            'INSERT INTO farmers (user_id, name, village, district, state, pincode, location, qr_code, preferred_language, bank_account_number, ifsc_code, upi_id) VALUES ($1, $2, $3, $4, $5, $6, ST_SetSRID(ST_MakePoint($7, $8), 4326), $9, $10, $11, $12, $13) RETURNING *',
            [
              newUser.id,
              user_data.name,
              user_data.village,
              user_data.district,
              user_data.state,
              user_data.pincode,
              user_data.longitude || 0,
              user_data.latitude || 0,
              qrCode,
              user_data.preferred_language || 'hi',
              user_data.bank_account_number,
              user_data.ifsc_code,
              user_data.upi_id
            ]
          );
          specificUserData = farmerInsert.rows[0];
        } else if (otpRecord.user_type === 'vendor') {
          const vendorInsert = await client.query(
            'INSERT INTO vendors (user_id, business_name, owner_name, business_type, address, city, state, pincode, location, gst_number, license_number) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ST_SetSRID(ST_MakePoint($9, $10), 4326), $11, $12) RETURNING *',
            [
              newUser.id,
              user_data.business_name,
              user_data.owner_name,
              user_data.business_type,
              user_data.address,
              user_data.city,
              user_data.state,
              user_data.pincode,
              user_data.longitude || 0,
              user_data.latitude || 0,
              user_data.gst_number,
              user_data.license_number
            ]
          );
          specificUserData = vendorInsert.rows[0];
        } else if (otpRecord.user_type === 'agent') {
          const agentInsert = await client.query(
            'INSERT INTO agents (user_id, name, license_number, vehicle_type, vehicle_number, current_location) VALUES ($1, $2, $3, $4, $5, ST_SetSRID(ST_MakePoint($6, $7), 4326)) RETURNING *',
            [
              newUser.id,
              user_data.name,
              user_data.license_number,
              user_data.vehicle_type,
              user_data.vehicle_number,
              user_data.longitude || 0,
              user_data.latitude || 0
            ]
          );
          specificUserData = agentInsert.rows[0];
        }

        return { ...newUser, ...specificUserData };
      });

    } else {
      // Existing user login
      user = userResult.rows[0];
    }

    // Delete used OTP
    await query('DELETE FROM otp_verifications WHERE phone_number = $1', [phone_number]);

    // Generate JWT token
    const token = generateToken(user.id, user.user_type);

    res.json({
      success: true,
      message: isNewUser ? 'Registration successful' : 'Login successful',
      data: {
        user: {
          id: user.id,
          phone_number: user.phone_number,
          user_type: user.user_type,
          is_active: user.is_active,
          profile: user
        },
        token,
        is_new_user: isNewUser
      }
    });

  } catch (error) {
    logger.error('Verify OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify OTP'
    });
  }
});

// Get current user profile
router.get('/profile', authenticate, async (req, res) => {
  try {
    let profileQuery;
    let profileData;

    switch (req.user.user_type) {
      case 'farmer':
        profileQuery = `
          SELECT u.*, f.*, 
                 ST_X(f.location::geometry) as longitude,
                 ST_Y(f.location::geometry) as latitude
          FROM users u 
          JOIN farmers f ON u.id = f.user_id 
          WHERE u.id = $1
        `;
        break;
      case 'vendor':
        profileQuery = `
          SELECT u.*, v.*,
                 ST_X(v.location::geometry) as longitude,
                 ST_Y(v.location::geometry) as latitude
          FROM users u 
          JOIN vendors v ON u.id = v.user_id 
          WHERE u.id = $1
        `;
        break;
      case 'agent':
        profileQuery = `
          SELECT u.*, a.*,
                 ST_X(a.current_location::geometry) as longitude,
                 ST_Y(a.current_location::geometry) as latitude
          FROM users u 
          JOIN agents a ON u.id = a.user_id 
          WHERE u.id = $1
        `;
        break;
      default:
        profileQuery = 'SELECT * FROM users WHERE id = $1';
    }

    const result = await query(profileQuery, [req.user.id]);
    profileData = result.rows[0];

    res.json({
      success: true,
      data: profileData
    });

  } catch (error) {
    logger.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get profile'
    });
  }
});

// Update user profile
router.put('/profile', authenticate, async (req, res) => {
  try {
    const updates = req.body;
    let updateQuery;
    let updateParams;

    switch (req.user.user_type) {
      case 'farmer':
        updateQuery = `
          UPDATE farmers SET 
            name = COALESCE($2, name),
            village = COALESCE($3, village),
            district = COALESCE($4, district),
            state = COALESCE($5, state),
            pincode = COALESCE($6, pincode),
            location = CASE WHEN $7 IS NOT NULL AND $8 IS NOT NULL 
                           THEN ST_SetSRID(ST_MakePoint($7, $8), 4326) 
                           ELSE location END,
            preferred_language = COALESCE($9, preferred_language),
            bank_account_number = COALESCE($10, bank_account_number),
            ifsc_code = COALESCE($11, ifsc_code),
            upi_id = COALESCE($12, upi_id)
          WHERE user_id = $1
          RETURNING *
        `;
        updateParams = [
          req.user.id,
          updates.name,
          updates.village,
          updates.district,
          updates.state,
          updates.pincode,
          updates.longitude,
          updates.latitude,
          updates.preferred_language,
          updates.bank_account_number,
          updates.ifsc_code,
          updates.upi_id
        ];
        break;
        
      case 'vendor':
        updateQuery = `
          UPDATE vendors SET 
            business_name = COALESCE($2, business_name),
            owner_name = COALESCE($3, owner_name),
            business_type = COALESCE($4, business_type),
            address = COALESCE($5, address),
            city = COALESCE($6, city),
            state = COALESCE($7, state),
            pincode = COALESCE($8, pincode),
            location = CASE WHEN $9 IS NOT NULL AND $10 IS NOT NULL 
                           THEN ST_SetSRID(ST_MakePoint($9, $10), 4326) 
                           ELSE location END,
            gst_number = COALESCE($11, gst_number),
            license_number = COALESCE($12, license_number)
          WHERE user_id = $1
          RETURNING *
        `;
        updateParams = [
          req.user.id,
          updates.business_name,
          updates.owner_name,
          updates.business_type,
          updates.address,
          updates.city,
          updates.state,
          updates.pincode,
          updates.longitude,
          updates.latitude,
          updates.gst_number,
          updates.license_number
        ];
        break;
        
      case 'agent':
        updateQuery = `
          UPDATE agents SET 
            name = COALESCE($2, name),
            license_number = COALESCE($3, license_number),
            vehicle_type = COALESCE($4, vehicle_type),
            vehicle_number = COALESCE($5, vehicle_number),
            current_location = CASE WHEN $6 IS NOT NULL AND $7 IS NOT NULL 
                                  THEN ST_SetSRID(ST_MakePoint($6, $7), 4326) 
                                  ELSE current_location END,
            is_available = COALESCE($8, is_available)
          WHERE user_id = $1
          RETURNING *
        `;
        updateParams = [
          req.user.id,
          updates.name,
          updates.license_number,
          updates.vehicle_type,
          updates.vehicle_number,
          updates.longitude,
          updates.latitude,
          updates.is_available
        ];
        break;
    }

    const result = await query(updateQuery, updateParams);

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: result.rows[0]
    });

  } catch (error) {
    logger.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update profile'
    });
  }
});

// Logout (invalidate token - in a real app, you'd maintain a blacklist)
router.post('/logout', authenticate, (req, res) => {
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

// Create OTP verifications table if it doesn't exist
const createOTPTable = async () => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS otp_verifications (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        phone_number VARCHAR(15) UNIQUE NOT NULL,
        otp VARCHAR(6) NOT NULL,
        user_type VARCHAR(20) NOT NULL,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (error) {
    logger.error('Failed to create OTP table:', error);
  }
};

createOTPTable();

module.exports = router;