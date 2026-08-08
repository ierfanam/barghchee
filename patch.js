const fs = require('fs');
let content = fs.readFileSync('human-avatar.ts', 'utf8');

content = content.replace(
  "if (name.includes('leftarm') || name.includes('left_arm')) this.leftArmBone = bone;",
  "if (name.includes('leftarm') || name.includes('left_arm') || name.includes('arm.l')) this.leftArmBone = bone;"
);

content = content.replace(
  "if (name.includes('rightarm') || name.includes('right_arm')) this.rightArmBone = bone;",
  "if (name.includes('rightarm') || name.includes('right_arm') || name.includes('arm.r')) this.rightArmBone = bone;"
);

content = content.replace(
  "lower.includes('a') || lower.includes('e') || lower.includes('o')) {",
  "lower.includes('a') || lower.includes('e') || lower.includes('o') || lower.includes('surprised')) {"
);

fs.writeFileSync('human-avatar.ts', content);
