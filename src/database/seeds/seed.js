const { query, transaction } = require('../connection');
const logger = require('../../utils/logger');
const QRCode = require('qrcode');

const seedDatabase = async () => {
  try {
    logger.info('Starting database seeding...');

    await transaction(async (client) => {
      // 1. Create sample users (farmers, vendors, agents, admin)
      logger.info('Creating sample users...');
      
      // Admin user
      const adminResult = await client.query(`
        INSERT INTO users (phone_number, user_type) 
        VALUES ('+919876543210', 'admin') 
        ON CONFLICT (phone_number) DO NOTHING
        RETURNING id
      `);
      
      let adminId;
      if (adminResult.rows.length > 0) {
        adminId = adminResult.rows[0].id;
      } else {
        const existingAdmin = await client.query(
          'SELECT id FROM users WHERE phone_number = $1', 
          ['+919876543210']
        );
        adminId = existingAdmin.rows[0].id;
      }

      // Sample farmers
      const farmers = [
        {
          phone: '+919876543211',
          name: 'राम शर्मा',
          village: 'रामपुर',
          district: 'वाराणसी',
          state: 'उत्तर प्रदेश',
          pincode: '221001',
          lat: 25.3176,
          lng: 82.9739,
          bank_account: '1234567890123456',
          ifsc: 'SBIN0001234',
          upi: 'ram.sharma@paytm'
        },
        {
          phone: '+919876543212',
          name: 'श्याम गुप्ता',
          village: 'श्यामपुर',
          district: 'प्रयागराज',
          state: 'उत्तर प्रदेश',
          pincode: '211001',
          lat: 25.4358,
          lng: 81.8463,
          bank_account: '2345678901234567',
          ifsc: 'HDFC0001234',
          upi: 'shyam.gupta@gpay'
        },
        {
          phone: '+919876543213',
          name: 'गीता देवी',
          village: 'गीतापुर',
          district: 'वाराणसी',
          state: 'उत्तर प्रदेश',
          pincode: '221002',
          lat: 25.2868,
          lng: 82.9734,
          bank_account: '3456789012345678',
          ifsc: 'ICICI001234',
          upi: 'geeta.devi@phonepe'
        }
      ];

      const farmerIds = [];
      for (const farmer of farmers) {
        // Create user
        const userResult = await client.query(`
          INSERT INTO users (phone_number, user_type) 
          VALUES ($1, 'farmer') 
          ON CONFLICT (phone_number) DO NOTHING
          RETURNING id
        `, [farmer.phone]);
        
        let userId;
        if (userResult.rows.length > 0) {
          userId = userResult.rows[0].id;
        } else {
          const existing = await client.query(
            'SELECT id FROM users WHERE phone_number = $1', 
            [farmer.phone]
          );
          userId = existing.rows[0].id;
        }

        // Generate QR code
        const qrCode = await QRCode.toDataURL(`farmer:${userId}`);
        
        // Create farmer profile
        const farmerResult = await client.query(`
          INSERT INTO farmers (
            user_id, name, village, district, state, pincode, 
            location, qr_code, bank_account_number, ifsc_code, upi_id, is_verified
          ) VALUES (
            $1, $2, $3, $4, $5, $6, 
            ST_SetSRID(ST_MakePoint($7, $8), 4326), $9, $10, $11, $12, true
          ) 
          ON CONFLICT (user_id) DO NOTHING
          RETURNING id
        `, [
          userId, farmer.name, farmer.village, farmer.district, farmer.state, farmer.pincode,
          farmer.lng, farmer.lat, qrCode, farmer.bank_account, farmer.ifsc, farmer.upi
        ]);
        
        if (farmerResult.rows.length > 0) {
          farmerIds.push({ userId, farmerId: farmerResult.rows[0].id });
        }
      }

      // Sample vendors
      const vendors = [
        {
          phone: '+919876543214',
          business_name: 'शर्मा चाट सेंटर',
          owner_name: 'राजेश शर्मा',
          address: 'गोदौलिया, वाराणसी',
          district: 'वाराणसी',
          state: 'उत्तर प्रदेश',
          pincode: '221001',
          lat: 25.3094,
          lng: 82.9859,
          business_type: 'restaurant'
        },
        {
          phone: '+919876543215',
          business_name: 'प्रेम वेजिटेबल शॉप',
          owner_name: 'प्रेम चंद',
          address: 'सिविल लाइन्स, प्रयागराज',
          district: 'प्रयागराज',
          state: 'उत्तर प्रदेश',
          pincode: '211001',
          lat: 25.4484,
          lng: 81.8428,
          business_type: 'retailer'
        }
      ];

      const vendorIds = [];
      for (const vendor of vendors) {
        // Create user
        const userResult = await client.query(`
          INSERT INTO users (phone_number, user_type) 
          VALUES ($1, 'vendor') 
          ON CONFLICT (phone_number) DO NOTHING
          RETURNING id
        `, [vendor.phone]);
        
        let userId;
        if (userResult.rows.length > 0) {
          userId = userResult.rows[0].id;
        } else {
          const existing = await client.query(
            'SELECT id FROM users WHERE phone_number = $1', 
            [vendor.phone]
          );
          userId = existing.rows[0].id;
        }

        // Create vendor profile
        const vendorResult = await client.query(`
          INSERT INTO vendors (
            user_id, business_name, owner_name, address, district, state, pincode,
            location, business_type, is_verified
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            ST_SetSRID(ST_MakePoint($8, $9), 4326), $10, true
          ) 
          ON CONFLICT (user_id) DO NOTHING
          RETURNING id
        `, [
          userId, vendor.business_name, vendor.owner_name, vendor.address, 
          vendor.district, vendor.state, vendor.pincode,
          vendor.lng, vendor.lat, vendor.business_type
        ]);
        
        if (vendorResult.rows.length > 0) {
          vendorIds.push({ userId, vendorId: vendorResult.rows[0].id });
        }
      }

      // Sample pickup agents
      const agents = [
        {
          phone: '+919876543216',
          name: 'विकास कुमार',
          vehicle_type: 'electric_bike',
          license_number: 'UP32AB1234',
          district: 'वाराणसी',
          state: 'उत्तर प्रदेश'
        },
        {
          phone: '+919876543217',
          name: 'अमित सिंह',
          vehicle_type: 'electric_van',
          license_number: 'UP32CD5678',
          district: 'प्रयागराज',
          state: 'उत्तर प्रदेश'
        }
      ];

      const agentIds = [];
      for (const agent of agents) {
        // Create user
        const userResult = await client.query(`
          INSERT INTO users (phone_number, user_type) 
          VALUES ($1, 'agent') 
          ON CONFLICT (phone_number) DO NOTHING
          RETURNING id
        `, [agent.phone]);
        
        let userId;
        if (userResult.rows.length > 0) {
          userId = userResult.rows[0].id;
        } else {
          const existing = await client.query(
            'SELECT id FROM users WHERE phone_number = $1', 
            [agent.phone]
          );
          userId = existing.rows[0].id;
        }

        // Create agent profile
        const agentResult = await client.query(`
          INSERT INTO pickup_agents (
            user_id, name, vehicle_type, license_number, district, state, is_verified
          ) VALUES ($1, $2, $3, $4, $5, $6, true) 
          ON CONFLICT (user_id) DO NOTHING
          RETURNING id
        `, [userId, agent.name, agent.vehicle_type, agent.license_number, agent.district, agent.state]);
        
        if (agentResult.rows.length > 0) {
          agentIds.push({ userId, agentId: agentResult.rows[0].id });
        }
      }

      // 2. Create sample products
      logger.info('Creating sample products...');
      const products = [
        { name: 'टमाटर', category: 'vegetables', unit: 'kg', seasonal: false },
        { name: 'आलू', category: 'vegetables', unit: 'kg', seasonal: false },
        { name: 'प्याज', category: 'vegetables', unit: 'kg', seasonal: false },
        { name: 'गेहूं', category: 'grains', unit: 'quintal', seasonal: true },
        { name: 'चावल', category: 'grains', unit: 'quintal', seasonal: true },
        { name: 'हरी मिर्च', category: 'vegetables', unit: 'kg', seasonal: false },
        { name: 'धनिया', category: 'herbs', unit: 'kg', seasonal: false },
        { name: 'आम', category: 'fruits', unit: 'kg', seasonal: true }
      ];

      const productIds = [];
      for (const product of products) {
        const result = await client.query(`
          INSERT INTO products (name, category, unit, seasonal) 
          VALUES ($1, $2, $3, $4) 
          ON CONFLICT (name) DO NOTHING
          RETURNING id
        `, [product.name, product.category, product.unit, product.seasonal]);
        
        if (result.rows.length > 0) {
          productIds.push({ id: result.rows[0].id, ...product });
        } else {
          const existing = await client.query('SELECT id FROM products WHERE name = $1', [product.name]);
          if (existing.rows.length > 0) {
            productIds.push({ id: existing.rows[0].id, ...product });
          }
        }
      }

      // 3. Create sample listings
      logger.info('Creating sample listings...');
      if (farmerIds.length > 0 && productIds.length > 0) {
        const listings = [
          { farmerId: farmerIds[0].farmerId, productId: productIds[0].id, quantity: 50, price: 25 },
          { farmerId: farmerIds[0].farmerId, productId: productIds[1].id, quantity: 100, price: 20 },
          { farmerId: farmerIds[1].farmerId, productId: productIds[2].id, quantity: 75, price: 30 },
          { farmerId: farmerIds[1].farmerId, productId: productIds[5].id, quantity: 25, price: 80 },
          { farmerId: farmerIds[2].farmerId, productId: productIds[6].id, quantity: 20, price: 120 }
        ];

        for (const listing of listings) {
          await client.query(`
            INSERT INTO listings (
              farmer_id, product_id, quantity_available, price_per_unit, 
              harvest_date, status
            ) VALUES ($1, $2, $3, $4, CURRENT_DATE + INTERVAL '1 day', 'available') 
            ON CONFLICT DO NOTHING
          `, [listing.farmerId, listing.productId, listing.quantity, listing.price]);
        }
      }

      // 4. Create pickup points
      logger.info('Creating pickup points...');
      const pickupPoints = [
        {
          name: 'रामपुर कलेक्शन सेंटर',
          address: 'रामपुर गांव के पास, मुख्य सड़क',
          district: 'वाराणसी',
          state: 'उत्तर प्रदेश',
          lat: 25.3180,
          lng: 82.9745
        },
        {
          name: 'श्यामपुर पिकअप पॉइंट',
          address: 'श्यामपुर चौराहा',
          district: 'प्रयागराज',
          state: 'उत्तर प्रदेश',
          lat: 25.4365,
          lng: 81.8470
        }
      ];

      for (const point of pickupPoints) {
        await client.query(`
          INSERT INTO pickup_points (
            name, address, district, state, location, is_active
          ) VALUES (
            $1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326), true
          ) ON CONFLICT (name) DO NOTHING
        `, [point.name, point.address, point.district, point.state, point.lng, point.lat]);
      }

      // 5. Create system configuration
      logger.info('Creating system configuration...');
      const configs = [
        { key: 'delivery_fee_per_kg', value: '3', description: 'Delivery fee per kg in rupees' },
        { key: 'vendor_commission_percent', value: '8', description: 'Commission percentage for vendors' },
        { key: 'agent_commission_percent', value: '15', description: 'Commission percentage for agents' },
        { key: 'hygiene_rating_threshold_yellow', value: '3.0', description: 'Hygiene rating threshold for yellow badge' },
        { key: 'hygiene_rating_threshold_red', value: '2.0', description: 'Hygiene rating threshold for red badge' },
        { key: 'max_delivery_distance_km', value: '50', description: 'Maximum delivery distance in kilometers' },
        { key: 'whatsapp_template_order_confirmation', value: 'order_confirmed', description: 'WhatsApp template for order confirmation' },
        { key: 'sms_fallback_enabled', value: 'true', description: 'Enable SMS fallback for communications' }
      ];

      for (const config of configs) {
        await client.query(`
          INSERT INTO system_config (config_key, config_value, description) 
          VALUES ($1, $2, $3) 
          ON CONFLICT (config_key) DO UPDATE SET 
            config_value = EXCLUDED.config_value,
            description = EXCLUDED.description
        `, [config.key, config.value, config.description]);
      }

      logger.info('Database seeding completed successfully!');
    });

  } catch (error) {
    logger.error('Seeding failed:', error);
    throw error;
  }
};

const clearDatabase = async () => {
  try {
    logger.info('Clearing database...');
    
    const tables = [
      'analytics_events', 'communications', 'disputes', 'payments', 
      'ratings', 'route_orders', 'routes', 'orders', 'listings', 
      'products', 'pickup_agents', 'vendors', 'farmers', 'users',
      'pickup_points', 'system_config', 'otp_verifications', 'user_preferences'
    ];
    
    for (const table of tables) {
      await query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
      logger.info(`Cleared table: ${table}`);
    }
    
    logger.info('Database cleared successfully!');
  } catch (error) {
    logger.error('Failed to clear database:', error);
    throw error;
  }
};

// Run seeding if this file is executed directly
if (require.main === module) {
  (async () => {
    try {
      // Check if we should clear first
      const shouldClear = process.argv.includes('--clear');
      
      if (shouldClear) {
        await clearDatabase();
      }
      
      await seedDatabase();
      logger.info('Seeding process completed successfully!');
      process.exit(0);
    } catch (error) {
      logger.error('Seeding process failed:', error);
      process.exit(1);
    }
  })();
}

module.exports = {
  seedDatabase,
  clearDatabase
};