const fs = require('fs');
let code = fs.readFileSync('server/crypto-monitor.ts', 'utf8');

// 1. Add import if missing
if (!code.includes('isPriceFresh')) {
    code = 'import { isPriceFresh } from "./websocket-stream";\n' + code;
}

// 2. Inject the integrity check
let target = 'const posQty = Number(pos.qty);';
let fix = `// --- PRICE INTEGRITY CHECK ---
      if (!isPriceFresh(pos.symbol)) {
        console.warn(\`[CRYPTO MONITOR] Stale price detected for \${pos.symbol}. Skipping check.\`);
        continue;
      }
      // -----------------------------
      const posQty = Number(pos.qty);`;

if (code.includes('PRICE INTEGRITY CHECK')) {
    console.log("⚠️ crypto-monitor.ts already has the fix!");
} else {
    fs.writeFileSync('server/crypto-monitor.ts', code.replace(target, fix));
    console.log("✅ crypto-monitor.ts successfully patched!");
}
