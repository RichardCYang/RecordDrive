const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'RecordDrive',
      script: path.join(__dirname, 'src', 'server.js'),
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      time: true,
      kill_timeout: 10000
    }
  ]
};
