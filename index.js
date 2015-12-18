/*
    SQL Adapter Common Code
    Plug in your favorite knex-supported RDBMS and use juttle to interact with it.
*/
var db = require('./lib/db');

function SqlAdapter(config) {
    db.init(config);

    return {
        name: 'sql',
        read: require('./lib/read'),
        write: require('./lib/write'),
        optimizer: require('./lib/optimize'),
        knex: db.getDbConnection()
    };
}
module.exports = SqlAdapter;