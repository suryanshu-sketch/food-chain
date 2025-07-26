const { query, transaction } = require('../connection');
const logger = require('../../utils/logger');
const QRCode = require('qrcode');

const seedData = async () => {
  try {
    logger.info('Starting database seeding...');

    await transaction(async (client) => {
      // Create admin user
      const adminResult = await client.query(`
        INSERT INTO users (phone_number, user_type) 
        VALUES ('+919999999999', 'admin') 
        ON CONFLICT (phone_number) DO NOTHING
        RETURNING id
      `);

      if (adminResult.rows.length > 0) {
        await client.query(`
          INSERT INTO admin (user_id, name, email, role) 
          VALUES ($1, 'System Admin', 'admin@agrisupply.com', 'super_admin')
          ON CONFLICT (user_id) DO NOTHING
        `, [adminResult.rows[0].id]);
        logger.info('Admin user created');
      }

      // Create sample farmers
      const farmers = [
        {
          phone: '+919876543210',
          name: 'राम कुमार',
          village: 'कृष्णपुर',
          district: 'वाराणसी',
          state: 'उत्तर प्रदेश',
          pincode: '221001',
          lat: 25.3176,
          lng: 82.9739
        },
        {
          phone: '+919876543211',
          name: 'सुरेश यादव',
          village: 'गंगापुर',
          district: 'प्रयागराज',
          state: 'उत्तर प्रदेश',
          pincode: '211001',
          lat: 25.4358,
          lng: 81.8463
        },
        {
          phone: '+919876543212',
          name: 'मुकेश सिंह',
          village: 'शिवपुर',
          district: 'वाराणसी',
          state: 'उत्तर प्रदेश',
          pincode: '221002',
          lat: 25.2677,
          lng: 82.9913
        }
      ];

      for (const farmer of farmers) {
        const userResult = await client.query(`
          INSERT INTO users (phone_number, user_type) 
          VALUES ($1, 'farmer') 
          ON CONFLICT (phone_number) DO NOTHING
          RETURNING id
        `, [farmer.phone]);

        if (userResult.rows.length > 0) {
          const userId = userResult.rows[0].id;
          const qrCode = await QRCode.toDataURL(`farmer:${userId}`);
          
          await client.query(`
            INSERT INTO farmers (
              user_id, name, village, district, state, pincode, 
              location, qr_code, hygiene_rating, hygiene_badge,
              bank_account_number, ifsc_code, upi_id, is_verified
            ) VALUES (
              $1, $2, $3, $4, $5, $6, 
              ST_SetSRID(ST_MakePoint($7, $8), 4326), $9, $10, $11,
              $12, $13, $14, true
            ) ON CONFLICT (user_id) DO NOTHING
          `, [
            userId, farmer.name, farmer.village, farmer.district, farmer.state, farmer.pincode,
            farmer.lng, farmer.lat, qrCode, 4.5, 'green',
            '1234567890123456', 'SBIN0001234', `${farmer.name.replace(/\s+/g, '').toLowerCase()}@paytm`,
          ]);
        }
      }
      logger.info('Sample farmers created');

      // Create sample vendors
      const vendors = [
        {
          phone: '+919876543220',
          name: 'Sharma Vegetables',
          business: 'Vegetable Shop',
          address: 'Cantonment, Varanasi',
          lat: 25.3176,
          lng: 82.9739
        },
        {
          phone: '+919876543221',
          name: 'Fresh Mart',
          business: 'Grocery Store',
          address: 'Civil Lines, Prayagraj',
          lat: 25.4358,
          lng: 81.8463
        }
      ];

      for (const vendor of vendors) {
        const userResult = await client.query(`
          INSERT INTO users (phone_number, user_type) 
          VALUES ($1, 'vendor') 
          ON CONFLICT (phone_number) DO NOTHING
          RETURNING id
        `, [vendor.phone]);

        if (userResult.rows.length > 0) {
          const userId = userResult.rows[0].id;
          
          await client.query(`
            INSERT INTO vendors (
              user_id, business_name, business_type, address, 
              location, is_verified, credit_limit
            ) VALUES (
              $1, $2, $3, $4, 
              ST_SetSRID(ST_MakePoint($5, $6), 4326), true, 50000.00
            ) ON CONFLICT (user_id) DO NOTHING
          `, [userId, vendor.name, vendor.business, vendor.address, vendor.lng, vendor.lat]);
        }
      }
      logger.info('Sample vendors created');

      // Create sample agents
      const agents = [
        {
          phone: '+919876543230',
          name: 'विकास कुमार',
          vehicle: 'Tata Ace EV',
          license: 'UP32AB1234'
        },
        {
          phone: '+919876543231',
          name: 'अनिल शर्मा',
          vehicle: 'Mahindra Treo',
          license: 'UP32CD5678'
        }
      ];

      for (const agent of agents) {
        const userResult = await client.query(`
          INSERT INTO users (phone_number, user_type) 
          VALUES ($1, 'agent') 
          ON CONFLICT (phone_number) DO NOTHING
          RETURNING id
        `, [agent.phone]);

        if (userResult.rows.length > 0) {
          const userId = userResult.rows[0].id;
          
          await client.query(`
            INSERT INTO agents (
              user_id, name, vehicle_type, vehicle_number, 
              license_number, is_verified, is_available
            ) VALUES (
              $1, $2, $3, $4, $5, true, true
            ) ON CONFLICT (user_id) DO NOTHING
          `, [userId, agent.name, agent.vehicle, agent.vehicle, agent.license]);
        }
      }
      logger.info('Sample agents created');

      // Create sample products
      const products = [
        { name: 'टमाटर', category: 'सब्जी', unit: 'kg', seasonal: false },
        { name: 'आलू', category: 'सब्जी', unit: 'kg', seasonal: false },
        { name: 'प्याज', category: 'सब्जी', unit: 'kg', seasonal: false },
        { name: 'गाजर', category: 'सब्जी', unit: 'kg', seasonal: true },
        { name: 'पालक', category: 'पत्तेदार सब्जी', unit: 'bunch', seasonal: true },
        { name: 'धनिया', category: 'पत्तेदार सब्जी', unit: 'bunch', seasonal: false },
        { name: 'मिर्च', category: 'मसाला', unit: 'kg', seasonal: false },
        { name: 'बैंगन', category: 'सब्जी', unit: 'kg', seasonal: true }
      ];

      for (const product of products) {
        await client.query(`
          INSERT INTO products (name, category, unit, is_seasonal) 
          VALUES ($1, $2, $3, $4) 
          ON CONFLICT (name) DO NOTHING
        `, [product.name, product.category, product.unit, product.seasonal]);
      }
      logger.info('Sample products created');

      // Create sample listings
      const farmerUsers = await client.query(`
        SELECT u.id as user_id, f.id as farmer_id 
        FROM users u 
        JOIN farmers f ON u.id = f.user_id 
        WHERE u.user_type = 'farmer'
      `);

      const productsList = await client.query('SELECT id, name FROM products LIMIT 5');

      for (const farmer of farmerUsers.rows) {
        for (let i = 0; i < 2; i++) {
          const product = productsList.rows[i % productsList.rows.length];
          const quantity = Math.floor(Math.random() * 50) + 10;
          const price = Math.floor(Math.random() * 30) + 20;
          
          await client.query(`
            INSERT INTO listings (
              farmer_id, product_id, quantity_available, price_per_unit,
              harvest_date, quality_grade, description, status
            ) VALUES (
              $1, $2, $3, $4, 
              CURRENT_DATE + INTERVAL '1 day', 'A', 
              'Fresh ${product.name} from organic farming', 'active'
            )
          `, [farmer.farmer_id, product.id, quantity, price]);
        }
      }
      logger.info('Sample listings created');

      // Create pickup points
      const pickupPoints = [
        {
          name: 'कृष्णपुर संग्रह केंद्र',
          address: 'Village Center, Krishnapur',
          lat: 25.3176,
          lng: 82.9739,
          district: 'वाराणसी'
        },
        {
          name: 'गंगापुर संग्रह केंद्र',
          address: 'Village Center, Gangapur',
          lat: 25.4358,
          lng: 81.8463,
          district: 'प्रयागराज'
        }
      ];

      for (const point of pickupPoints) {
        await client.query(`
          INSERT INTO pickup_points (
            name, address, location, district, 
            operating_hours, contact_person, is_active
          ) VALUES (
            $1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), $5,
            '06:00-18:00', 'Local Coordinator', true
          ) ON CONFLICT (name) DO NOTHING
        `, [point.name, point.address, point.lng, point.lat, point.district]);
      }
      logger.info('Sample pickup points created');

      // Create system configuration
      await client.query(`
        INSERT INTO system_config (key, value, description) VALUES
        ('max_delivery_distance', '50', 'Maximum delivery distance in km'),
        ('default_commission_rate', '8', 'Default commission rate in percentage'),
        ('min_order_value', '100', 'Minimum order value in rupees'),
        ('max_route_stops', '12', 'Maximum stops per route'),
        ('hygiene_rating_threshold', '3.0', 'Minimum hygiene rating threshold')
        ON CONFLICT (key) DO NOTHING
      `);
      logger.info('System configuration created');

    });

    logger.info('Database seeding completed successfully!');

  } catch (error) {
    logger.error('Seeding failed:', error);
    throw error;
  }
};

// Run seeding if called directly
if (require.main === module) {
  seedData()
    .then(() => {
      logger.info('Seeding completed');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Seeding failed:', error);
      process.exit(1);
    });
}

module.exports = { seedData };