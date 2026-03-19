const fs = require('fs');
const filePath = 'client/src/index.css';
let code = fs.readFileSync(filePath, 'utf8');

// Separate the Google Fonts import from the rest
const fontImportRegex = /@import url\([^)]+\);\n?/g;
const fontImports = code.match(fontImportRegex) || [];
code = code.replace(fontImportRegex, '');

// Ensure Tailwind is there, then put fonts at the absolute top
if (code.includes('@import "tailwindcss";')) {
    code = fontImports.join('') + '\n' + code;
    fs.writeFileSync(filePath, code.trim() + '\n');
    console.log("✅ index.css successfully patched! Google Fonts is now at the top.");
} else {
    console.log("⚠️ Could not find tailwindcss import in index.css.");
}
