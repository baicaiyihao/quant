module.exports = {
  apps: [{
    name: 'bluequant',
    script: 'dist/index.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 8080
    },
    env_file: '.env',
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    // 自动重启配置
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    // 崩溃重启延迟
    restart_delay: 4000,
    // 监听文件变化（开发时使用）
    ignore_watch: ['node_modules', 'logs', 'dist'],
    // 进程管理
    kill_timeout: 5000,
    listen_timeout: 3000,
    // 日志配置
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    // 环境变量
    env_production: {
      NODE_ENV: 'production'
    }
  }]
}; 