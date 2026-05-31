// db/database.js — Database initialization and connection
let db = null;

function getDb() {
  if (!db) {
    // Initialize your database connection here
    // Example: connect to PostgreSQL, MongoDB, SQLite, etc.
    console.log('📦 Database initialized');
    db = {
      // Add your database connection/client here
      // Example: { client: pgClient, query: (sql) => pgClient.query(sql) }
    };
  }
  return db;
}

module.exports = { getDb };

