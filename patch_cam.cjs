const fs = require('fs');
let content = fs.readFileSync('human-avatar.ts', 'utf8');

content = content.replace(
  "this.camera.position.set(0, 0.5, 3.5);",
  "this.camera.position.set(0, 1.0, 8.0);"
);

content = content.replace(
  "this.controls.target.set(0, 0.4, 0);",
  "this.controls.target.set(0, 1.0, 0);"
);

content = content.replace(
  "this.controls.maxDistance = 6;",
  "this.controls.maxDistance = 15;"
);

fs.writeFileSync('human-avatar.ts', content);
