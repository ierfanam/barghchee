const THREE = require('three');
class CFLHelix extends THREE.Curve {
    getPoint(t, optionalTarget = new THREE.Vector3()) {
        const turns = 3;
        const radius = 0.12;
        const height = 0.6;
        
        if (t < 0.45) {
            const p = t / 0.45; 
            const angle = p * Math.PI * 2 * turns;
            const y = 0.8 - p * height;
            return optionalTarget.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
        } else if (t > 0.55) {
            const p = (t - 0.55) / 0.45; 
            const y = 0.8 - height + p * height;
            const angle = (1 - p) * Math.PI * 2 * turns + Math.PI;
            return optionalTarget.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
        } else {
            const p = (t - 0.45) / 0.1; 
            const angle = p * Math.PI;
            const y = 0.8 - height - Math.sin(angle) * 0.05; 
            return optionalTarget.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
        }
    }
}
const helix = new CFLHelix();
console.log(helix.getPoint(0.45));
console.log(helix.getPoint(0.50));
console.log(helix.getPoint(0.55));
