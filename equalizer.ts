import {LitElement, css, html} from 'lit';
import {customElement, property, query} from 'lit/decorators.js';
import {Analyser} from './analyser';

@customElement('audio-equalizer')
export class AudioEqualizer extends LitElement {
  @property({attribute: false}) inputNode!: AudioNode;
  @property({attribute: false}) outputNode!: AudioNode;

  @query('canvas') canvas!: HTMLCanvasElement;

  private inputAnalyser!: Analyser;
  private outputAnalyser!: Analyser;
  private animationFrameId = 0;
  private canvasCtx!: CanvasRenderingContext2D | null;

  static styles = css`
    :host {
      display: block;
      position: absolute;
      bottom: 70px;
      left: 0;
      right: 0;
      height: 100px;
      z-index: 50;
      pointer-events: none;
    }
    .equalizer-container {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100%;
      width: 100%;
      padding: 0 20px;
      box-sizing: border-box;
    }
    canvas {
      width: 100%;
      height: 100%;
      max-width: 800px;
    }
  `;

  protected firstUpdated() {
    if (this.canvas) {
      this.canvasCtx = this.canvas.getContext('2d');
      // Set actual size in memory (scaled for retina displays)
      const rect = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = (rect.width || 800) * dpr;
      this.canvas.height = (rect.height || 100) * dpr;
      if (this.canvasCtx) {
        this.canvasCtx.scale(dpr, dpr);
      }
    }

    if (this.inputNode && this.outputNode) {
      this.inputAnalyser = new Analyser(this.inputNode);
      this.outputAnalyser = new Analyser(this.outputNode);
      this.renderLoop();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this.animationFrameId);
  }

  private renderLoop = () => {
    this.inputAnalyser.update();
    this.outputAnalyser.update();
    
    this.drawCanvas();
    
    this.animationFrameId = requestAnimationFrame(this.renderLoop);
  };

  private drawCanvas() {
    if (!this.canvasCtx || !this.canvas) return;

    const width = this.canvas.width / (window.devicePixelRatio || 1);
    const height = this.canvas.height / (window.devicePixelRatio || 1);

    this.canvasCtx.clearRect(0, 0, width, height);

    const inputData = this.inputAnalyser.data;
    const outputData = this.outputAnalyser.data;
    
    const numBars = Math.min(inputData.length, outputData.length);
    if (numBars === 0) return;

    // Use a subset of bars to fit nicely
    const displayBars = Math.min(numBars, 64);
    const barWidth = (width / (displayBars * 2)) * 0.8;
    const barSpacing = (width / (displayBars * 2)) * 0.2;
    
    const centerX = width / 2;

    this.canvasCtx.fillStyle = 'rgba(0, 170, 255, 0.8)';
    this.canvasCtx.shadowColor = 'rgba(0, 170, 255, 0.5)';
    this.canvasCtx.shadowBlur = 10;

    for (let i = 0; i < displayBars; i++) {
      const val = Math.max(inputData[i], outputData[i]);
      const barHeight = Math.max(2, (val / 255) * height * 0.8);

      const y = height / 2 - barHeight / 2;
      
      const xRight = centerX + i * (barWidth + barSpacing) + barSpacing / 2;
      const xLeft = centerX - (i + 1) * (barWidth + barSpacing) + barSpacing / 2;

      // Make colors dynamic based on height
      const gradient = this.canvasCtx.createLinearGradient(0, height/2 - barHeight/2, 0, height/2 + barHeight/2);
      if (outputData[i] > inputData[i]) {
        // AI Speaking color
        gradient.addColorStop(0, '#f59e0b');
        gradient.addColorStop(0.5, '#fbbf24');
        gradient.addColorStop(1, '#f59e0b');
        this.canvasCtx.shadowColor = 'rgba(245, 158, 11, 0.5)';
      } else {
        // User speaking color
        gradient.addColorStop(0, '#00aaff');
        gradient.addColorStop(0.5, '#646cff');
        gradient.addColorStop(1, '#00aaff');
        this.canvasCtx.shadowColor = 'rgba(100, 108, 255, 0.5)';
      }
      
      this.canvasCtx.fillStyle = gradient;

      // Draw right side
      this.canvasCtx.beginPath();
      this.canvasCtx.roundRect(xRight, y, barWidth, barHeight, barWidth / 2);
      this.canvasCtx.fill();

      // Draw left side (mirrored)
      this.canvasCtx.beginPath();
      this.canvasCtx.roundRect(xLeft, y, barWidth, barHeight, barWidth / 2);
      this.canvasCtx.fill();
    }
  }

  render() {
    return html`
      <div class="equalizer-container">
        <canvas></canvas>
      </div>
    `;
  }
}
