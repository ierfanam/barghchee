const fs = require('fs');
const content = fs.readFileSync('human-avatar.ts', 'utf8');
const newBulb = fs.readFileSync('newBulb.txt', 'utf8');

const startStr = '  private buildBulb() {';
const endStr = '  private onResize = () => {';

const startIndex = content.indexOf(startStr);
const endIndex = content.indexOf(endStr);

fs.writeFileSync('human-avatar.ts', content.slice(0, startIndex) + newBulb + '\n' + content.slice(endIndex));
