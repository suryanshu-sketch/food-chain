const fs = require('fs');
const path = require('path');
const { pool, query } = require('../connection');
const logger = require('../../utils/logger');

const runMigrations = async () => {
  try {
    logger.info('Starting database migrations...');
    
    // Read and execute schema.sql
    const schemaPath = path.join(__dirname, '..', 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    
    // Split by semicolon and execute each statement
    const statements = schemaSql
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0);
    
    for (const statement of statements) {
      try {
        await query(statement);
        logger.info(`Executed: ${statement.substring(0, 50)}...`);
      } catch (error) {
        if (error.message.includes('already exists')) {
          logger.warn(`Skipping existing: ${statement.substring(0, 50)}...`);
        } else {
          throw error;
        }
      }
    }
    
    // Create additional indexes for performance
    const additionalIndexes = [
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_vendor_created ON orders(vendor_id, created_at DESC)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_farmer_created ON orders(farmer_id, created_at DESC)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_location ON listings USING GIST(location)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_farmers_location ON farmers USING GIST(location)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vendors_location ON vendors USING GIST(location)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ratings_created ON ratings(created_at DESC)',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_communications_user_created ON communications(user_id, created_at DESC)'
    ];
    
    for (const indexSql of additionalIndexes) {
      try {
        await query(indexSql);
        logger.info(`Created index: ${indexSql.substring(0, 60)}...`);
      } catch (error) {
        if (error.message.includes('already exists')) {
          logger.warn(`Index already exists: ${indexSql.substring(0, 60)}...`);
        } else {
          logger.error(`Failed to create index: ${error.message}`);
        }
      }
    }
    
    logger.info('Database migrations completed successfully!');
    
  } catch (error) {
    logger.error('Migration failed:', error);
    throw error;
  }
};

const checkConnection = async () => {
  try {
    await query('SELECT NOW()');
    logger.info('Database connection verified');
    return true;
  } catch (error) {
    logger.error('Database connection failed:', error);
    return false;
  }
};

// Run migrations if this file is executed directly
if (require.main === module) {
  (async () => {
    try {
      const connected = await checkConnection();
      if (!connected) {
        process.exit(1);
      }
      
      await runMigrations();
      logger.info('All migrations completed successfully!');
      process.exit(0);
    } catch (error) {
      logger.error('Migration process failed:', error);
      process.exit(1);
    }
  })();
}

module.exports = {
  runMigrations,
  checkConnection
};