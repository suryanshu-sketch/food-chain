const fs = require('fs');
const path = require('path');
const { query, connectDB, closePool } = require('../connection');
const logger = require('../../utils/logger');

const runMigrations = async () => {
  try {
    logger.info('Starting database migrations...');
    
    // Connect to database
    await connectDB();
    
    // Read and execute schema file
    const schemaPath = path.join(__dirname, '..', 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    // Split by semicolon and execute each statement
    const statements = schema.split(';').filter(stmt => stmt.trim().length > 0);
    
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i].trim();
      if (statement) {
        try {
          await query(statement);
          logger.info(`Executed migration statement ${i + 1}/${statements.length}`);
        } catch (error) {
          // Skip if table/extension already exists
          if (error.code === '42P07' || error.code === '58P01') {
            logger.info(`Skipping existing object in statement ${i + 1}`);
            continue;
          }
          throw error;
        }
      }
    }
    
    logger.info('Database migrations completed successfully!');
    
  } catch (error) {
    logger.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await closePool();
  }
};

// Run migrations if called directly
if (require.main === module) {
  runMigrations();
}

module.exports = { runMigrations };