const fs = require('fs');
const path = require('path');
const { pool } = require('../connection');
const logger = require('../../utils/logger');

const runMigrations = async () => {
  try {
    logger.info('Starting database migrations...');
    
    // Read the schema file
    const schemaPath = path.join(__dirname, '..', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    // Execute the schema
    await pool.query(schema);
    
    logger.info('Database migrations completed successfully');
    console.log('✅ Database schema created successfully');
    
  } catch (error) {
    logger.error('Migration failed:', error);
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

// Run migrations if this file is executed directly
if (require.main === module) {
  runMigrations();
}

module.exports = { runMigrations };