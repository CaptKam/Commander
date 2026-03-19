const fs = require('fs');
let code = fs.readFileSync('server/exit-manager.ts', 'utf8');
let target = '// Track consecutive no-price cycles for this symbol';
let fix = `// --- PRICE INTEGRITY CHECK ---
        if (!isPriceFresh(signal.symbol)) {
          console.warn(\`[EXIT MANAGER] Stale price detected for \${signal.symbol}. Skipping exit evaluation to protect capital.\`);
          continue; 
        }
        // -----------------------------
        // Track consecutive no-price cycles for this symbol`;
fs.writeFileSync('server/exit-manager.ts', code.replace(target, fix));
console.log("✅ exit-manager.ts successfully patched!");
