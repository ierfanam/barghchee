const fs = require('fs');
const buffer = fs.readFileSync('public/avatar.glb');
const chunk0Len = buffer.readUInt32LE(12);
const chunk0Type = buffer.readUInt32LE(16);
if (chunk0Type === 0x4E4F534A) {
  const jsonStr = buffer.toString('utf8', 20, 20 + chunk0Len);
  const json = JSON.parse(jsonStr);
  
  if (json.nodes) {
    json.nodes.forEach((n, i) => {
       console.log("Node " + i + ": " + n.name);
    });
  }
}
