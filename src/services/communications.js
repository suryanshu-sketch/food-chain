const twilio = require('twilio');
const axios = require('axios');
const { query } = require('../database/connection');
const logger = require('../utils/logger');

// Initialize Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// SMS Service using Twilio
const sendSMS = async (phoneNumber, message, userId = null) => {
  try {
    const formattedPhone = phoneNumber.startsWith('+91') ? phoneNumber : `+91${phoneNumber}`;
    
    const smsResponse = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: formattedPhone
    });

    // Log communication
    if (userId) {
      await query(
        'INSERT INTO communications (user_id, type, direction, content, status, external_id, cost) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [userId, 'sms', 'outbound', message, 'sent', smsResponse.sid, 0.02]
      );
    }

    logger.info(`SMS sent successfully to ${phoneNumber}: ${smsResponse.sid}`);
    return {
      success: true,
      messageId: smsResponse.sid,
      status: smsResponse.status
    };

  } catch (error) {
    logger.error('SMS sending failed:', error);
    
    // Log failed communication
    if (userId) {
      await query(
        'INSERT INTO communications (user_id, type, direction, content, status, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
        [userId, 'sms', 'outbound', message, 'failed', JSON.stringify({ error: error.message })]
      );
    }

    throw error;
  }
};

// WhatsApp Service using Gupshup
const sendWhatsApp = async (phoneNumber, message, userId = null, templateName = null, templateParams = null) => {
  try {
    const formattedPhone = phoneNumber.startsWith('91') ? phoneNumber : `91${phoneNumber}`;
    
    let payload;
    
    if (templateName && templateParams) {
      // Template message
      payload = {
        channel: 'whatsapp',
        source: process.env.GUPSHUP_APP_NAME,
        destination: formattedPhone,
        message: {
          type: 'template',
          template: {
            name: templateName,
            language: {
              code: 'hi',
              policy: 'deterministic'
            },
            components: templateParams
          }
        }
      };
    } else {
      // Simple text message
      payload = {
        channel: 'whatsapp',
        source: process.env.GUPSHUP_APP_NAME,
        destination: formattedPhone,
        message: {
          type: 'text',
          text: message
        }
      };
    }

    const response = await axios.post(
      'https://api.gupshup.io/sm/api/v1/msg',
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.GUPSHUP_API_KEY
        }
      }
    );

    // Log communication
    if (userId) {
      await query(
        'INSERT INTO communications (user_id, type, direction, content, status, external_id, cost) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [userId, 'whatsapp', 'outbound', message, 'sent', response.data.messageId, 0.05]
      );
    }

    logger.info(`WhatsApp sent successfully to ${phoneNumber}: ${response.data.messageId}`);
    return {
      success: true,
      messageId: response.data.messageId,
      status: response.data.status
    };

  } catch (error) {
    logger.error('WhatsApp sending failed:', error);
    
    // Log failed communication
    if (userId) {
      await query(
        'INSERT INTO communications (user_id, type, direction, content, status, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
        [userId, 'whatsapp', 'outbound', message, 'failed', JSON.stringify({ error: error.message })]
      );
    }

    throw error;
  }
};

// IVR Service using Exotel
const makeIVRCall = async (phoneNumber, flowId, userId = null) => {
  try {
    const formattedPhone = phoneNumber.startsWith('0') ? phoneNumber.substring(1) : phoneNumber;
    
    const response = await axios.post(
      `https://api.exotel.com/v1/Accounts/${process.env.EXOTEL_SID}/Calls/connect.json`,
      {
        From: process.env.EXOTEL_PHONE_NUMBER,
        To: formattedPhone,
        CallerId: process.env.EXOTEL_PHONE_NUMBER,
        Url: `https://your-domain.com/ivr/flow/${flowId}`,
        CallType: 'trans'
      },
      {
        auth: {
          username: process.env.EXOTEL_API_KEY,
          password: process.env.EXOTEL_API_TOKEN
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    // Log communication
    if (userId) {
      await query(
        'INSERT INTO communications (user_id, type, direction, content, status, external_id, cost) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [userId, 'ivr', 'outbound', `IVR call flow: ${flowId}`, 'sent', response.data.Call.Sid, 0.15]
      );
    }

    logger.info(`IVR call initiated successfully to ${phoneNumber}: ${response.data.Call.Sid}`);
    return {
      success: true,
      callId: response.data.Call.Sid,
      status: response.data.Call.Status
    };

  } catch (error) {
    logger.error('IVR call failed:', error);
    
    // Log failed communication
    if (userId) {
      await query(
        'INSERT INTO communications (user_id, type, direction, content, status, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
        [userId, 'ivr', 'outbound', `IVR call flow: ${flowId}`, 'failed', JSON.stringify({ error: error.message })]
      );
    }

    throw error;
  }
};

// Send notification based on user preference and fallback
const sendNotification = async (userId, message, type = 'general', priority = 'normal') => {
  try {
    // Get user details and preferences
    const userResult = await query(
      `SELECT u.phone_number, u.user_type, 
              f.preferred_language, f.name as farmer_name,
              v.business_name, v.owner_name,
              a.name as agent_name
       FROM users u 
       LEFT JOIN farmers f ON u.id = f.user_id 
       LEFT JOIN vendors v ON u.id = v.user_id 
       LEFT JOIN agents a ON u.id = a.user_id 
       WHERE u.id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      throw new Error('User not found');
    }

    const user = userResult.rows[0];
    const phoneNumber = user.phone_number;

    // Translate message if needed
    let translatedMessage = message;
    if (user.preferred_language === 'hi' && user.user_type === 'farmer') {
      translatedMessage = await translateToHindi(message);
    }

    let success = false;
    let method = '';

    // For farmers: Try WhatsApp first, then SMS, then IVR for urgent messages
    if (user.user_type === 'farmer') {
      try {
        await sendWhatsApp(phoneNumber, translatedMessage, userId);
        success = true;
        method = 'whatsapp';
      } catch (whatsappError) {
        logger.warn('WhatsApp failed, trying SMS:', whatsappError);
        try {
          await sendSMS(phoneNumber, translatedMessage, userId);
          success = true;
          method = 'sms';
        } catch (smsError) {
          logger.warn('SMS failed, trying IVR for urgent messages:', smsError);
          if (priority === 'urgent') {
            await makeIVRCall(phoneNumber, 'urgent_notification', userId);
            success = true;
            method = 'ivr';
          } else {
            throw smsError;
          }
        }
      }
    } 
    // For vendors and agents: Try app push notification first, then SMS
    else {
      try {
        // In a real implementation, you'd send push notification here
        // For now, we'll use SMS as primary
        await sendSMS(phoneNumber, message, userId);
        success = true;
        method = 'sms';
      } catch (smsError) {
        // Fallback to WhatsApp
        await sendWhatsApp(phoneNumber, message, userId);
        success = true;
        method = 'whatsapp';
      }
    }

    // Log notification in database
    await query(
      'INSERT INTO notifications (user_id, title, message, type, data) VALUES ($1, $2, $3, $4, $5)',
      [userId, type, message, type, JSON.stringify({ method, priority })]
    );

    return { success, method };

  } catch (error) {
    logger.error('Notification sending failed:', error);
    throw error;
  }
};

// Simple Hindi translation (in production, use a proper translation service)
const translateToHindi = async (text) => {
  const translations = {
    'Order confirmed': 'ऑर्डर कन्फर्म हो गया',
    'Pickup scheduled': 'पिकअप शेड्यूल हो गया',
    'Payment received': 'पेमेंट मिल गया',
    'Order delivered': 'ऑर्डर डिलीवर हो गया',
    'New order': 'नया ऑर्डर',
    'Rating received': 'रेटिंग मिली'
  };

  return translations[text] || text;
};

// Bulk notification service
const sendBulkNotifications = async (userIds, message, type = 'general') => {
  const results = [];
  
  for (const userId of userIds) {
    try {
      const result = await sendNotification(userId, message, type);
      results.push({ userId, success: true, method: result.method });
    } catch (error) {
      results.push({ userId, success: false, error: error.message });
    }
  }

  return results;
};

// WhatsApp webhook handler for incoming messages
const handleWhatsAppWebhook = async (req, res) => {
  try {
    const { type, payload } = req.body;

    if (type === 'message') {
      const { source, message } = payload;
      const phoneNumber = source.replace('91', '');

      // Find user by phone number
      const userResult = await query(
        'SELECT id FROM users WHERE phone_number = $1',
        [phoneNumber]
      );

      if (userResult.rows.length > 0) {
        const userId = userResult.rows[0].id;

        // Log incoming message
        await query(
          'INSERT INTO communications (user_id, type, direction, content, status, external_id) VALUES ($1, $2, $3, $4, $5, $6)',
          [userId, 'whatsapp', 'inbound', message.text, 'received', payload.id]
        );

        // Process message (implement your business logic here)
        await processIncomingMessage(userId, message.text, 'whatsapp');
      }
    }

    res.status(200).json({ success: true });

  } catch (error) {
    logger.error('WhatsApp webhook error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Process incoming messages
const processIncomingMessage = async (userId, message, channel) => {
  try {
    // Simple command processing
    const lowerMessage = message.toLowerCase().trim();

    if (lowerMessage.includes('order') || lowerMessage.includes('ऑर्डर')) {
      // Handle order inquiry
      const orders = await query(
        'SELECT * FROM orders WHERE farmer_id = (SELECT id FROM farmers WHERE user_id = $1) OR vendor_id = (SELECT id FROM vendors WHERE user_id = $1) ORDER BY created_at DESC LIMIT 3',
        [userId]
      );

      let response = 'आपके हाल के ऑर्डर:\n';
      orders.rows.forEach((order, index) => {
        response += `${index + 1}. ऑर्डर #${order.order_number} - ${order.status}\n`;
      });

      await sendNotification(userId, response, 'order_inquiry');
    }
    else if (lowerMessage.includes('help') || lowerMessage.includes('मदद')) {
      const helpMessage = `मदद के लिए:\n1. ऑर्डर देखने के लिए "order" टाइप करें\n2. सपोर्ट के लिए कॉल करें: 1800-XXX-XXXX`;
      await sendNotification(userId, helpMessage, 'help');
    }

  } catch (error) {
    logger.error('Message processing error:', error);
  }
};

module.exports = {
  sendSMS,
  sendWhatsApp,
  makeIVRCall,
  sendNotification,
  sendBulkNotifications,
  handleWhatsAppWebhook,
  processIncomingMessage
};