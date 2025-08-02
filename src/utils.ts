// 格式化对象数据Json
export function toJson(obj: Object): string {
    return JSON.stringify(obj, null, 2);
}

// 格式化打印
export function print(obj: object): void {
    console.dir(obj, {depth: null});
}


// 将字符串转换为精度的数
export function stringToDividedNumber(input: string, decimals: number | null): number {
    decimals = decimals ? decimals : 0;
    const number = parseInt(input, 10);
    if (isNaN(number)) {
        throw new Error("输入的字符串无法转换为有效的整数");
    }
    return number / Math.pow(10, decimals);
}

// coin类型转名称
export function coinTypeToName(coinType: string): string {
    return coinType.split("::")[2];

}

export function calTickIndex(currentIndex: number, tickSpacing: number, g1: number, g2: number, minRangeMultiplier: number = 3) {
    const lowerIndex = (Math.floor(currentIndex / tickSpacing) - g1) * tickSpacing;
    const upperIndex = (Math.floor(currentIndex / tickSpacing) + g2) * tickSpacing;
    
    // 确保最小区间不小于配置的倍数
    const minRange = tickSpacing * minRangeMultiplier;
    const currentRange = upperIndex - lowerIndex;
    
    if (currentRange < minRange) {
        // 以当前tick为中心，扩展到最小区间
        const currentTick = Math.floor(currentIndex / tickSpacing) * tickSpacing;
        const halfMinRange = Math.floor(minRange / 2 / tickSpacing) * tickSpacing;
        const adjustedLower = currentTick - halfMinRange;
        const adjustedUpper = currentTick + halfMinRange;
        
        // 确保区间是tickSpacing的倍数
        return [adjustedLower, adjustedUpper];
    }
    
    // 确保当前tick在区间内
    if (currentIndex <= lowerIndex || currentIndex >= upperIndex) {
        // 重新计算，确保当前tick在区间中间
        const currentTick = Math.floor(currentIndex / tickSpacing) * tickSpacing;
        const halfRange = Math.floor(currentRange / 2 / tickSpacing) * tickSpacing;
        return [currentTick - halfRange, currentTick + halfRange];
    }
    
    return [lowerIndex, upperIndex]
}

export function scalingUp(value: number, decimals: number) {
    return Math.round(value * Math.pow(10, decimals));
}

export function scalingDown(value: number, decimals: number) {
    return value / Math.pow(10, decimals);
}