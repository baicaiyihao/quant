import express from 'express';
import cors from 'cors';
import { logger } from './Logger';
import { getEnvConfig } from './config';

const app = express();
const envConfig = getEnvConfig();
const PORT = envConfig.PORT;

// API key 校验中间件
function validateApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
        logger.warn('请求缺少 x-api-key header');
        return res.status(401).json({
            success: false,
            message: '缺少 x-api-key header'
        });
    }
    
    if (apiKey !== envConfig.API_KEY) {
        logger.warn('API key 验证失败');
        return res.status(401).json({
            success: false,
            message: 'API key 无效'
        });
    }
    
    next();
}

// 中间件
app.use(cors());
app.use(express.json());

// 全局变量存储策略实例
let strategyInstance: any = null;

// 设置策略实例
export function setStrategyInstance(strategy: any) {
    strategyInstance = strategy;
}

// 启动策略
app.post('/start', validateApiKey, (req, res) => {
    try {
        if (!strategyInstance) {
            return res.status(400).json({ 
                success: false, 
                message: '策略实例未初始化' 
            });
        }

        const status = strategyInstance.getStatus();
        if (status.isRunning) {
            return res.status(400).json({ 
                success: false, 
                message: '策略已在运行中' 
            });
        }

        // 启动策略
        strategyInstance.run().catch((error: any) => {
            logger.error('策略运行出错:', error);
        });

        logger.info('策略已启动');
        res.json({ 
            success: true, 
            message: '策略已启动' 
        });
    } catch (error) {
        logger.error('启动策略失败:', error);
        res.status(500).json({ 
            success: false, 
            message: '启动策略失败' 
        });
    }
});

// 停止策略
app.post('/stop', validateApiKey, (req, res) => {
    try {
        if (!strategyInstance) {
            return res.status(400).json({ 
                success: false, 
                message: '策略实例未初始化' 
            });
        }

        const status = strategyInstance.getStatus();
        if (!status.isRunning) {
            return res.status(400).json({ 
                success: false, 
                message: '策略未在运行' 
            });
        }

        // 停止策略
        strategyInstance.stop();

        logger.info('策略已停止');
        res.json({ 
            success: true, 
            message: '策略已停止' 
        });
    } catch (error) {
        logger.error('停止策略失败:', error);
        res.status(500).json({ 
            success: false, 
            message: '停止策略失败' 
        });
    }
});

// 获取策略状态
app.get('/status', validateApiKey, (req, res) => {
    try {
        const status = {
            hasStrategyInstance: !!strategyInstance
        };

        if (strategyInstance && strategyInstance.getStatus) {
            Object.assign(status, strategyInstance.getStatus());
        }

        res.json({ 
            success: true, 
            data: status 
        });
    } catch (error) {
        logger.error('获取状态失败:', error);
        res.status(500).json({ 
            success: false, 
            message: '获取状态失败' 
        });
    }
});

// 健康检查
app.get('/health', (req, res) => {
    res.json({ 
        success: true, 
        message: '服务器运行正常' 
    });
});

// 启动服务器
export function startServer() {
    app.listen(PORT, () => {
        logger.info(`HTTP服务器已启动，监听端口: ${PORT}`);
        logger.info(`API接口:`);
        logger.info(`  POST /start - 启动策略`);
        logger.info(`  POST /stop - 停止策略`);
        logger.info(`  GET /status - 获取策略状态`);
        logger.info(`  GET /health - 健康检查`);
    });
} 