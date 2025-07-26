const fs = require('fs');
const path = require('path');
const { pool } = require('../connection');
const logger = require('../../utils/logger');

const migrate = async () => {
  const client = await pool.connect();
  
  try {
    logger.info('Starting database migration...');
    
    // Read the schema file
    const schemaPath = path.join(__dirname, '..', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    // Execute the schema
    await client.query(schema);
    
    logger.info('Database migration completed successfully');
    
    // Create migration record
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await client.query(`
      INSERT INTO migrations (name) 
      VALUES ('initial_schema') 
      ON CONFLICT DO NOTHING
    `);
    
    logger.info('Migration record created');
    
  } catch (error) {
    logger.error('Migration failed:', error);
    throw error;
  } finally {
    client.release();
  }
};

// Run migration if called directly
if (require.main === module) {
  migrate()
    .then(() => {
      logger.info('Migration completed');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Migration failed:', error);
      process.exit(1);
    });
}

module.exports = { migrate };