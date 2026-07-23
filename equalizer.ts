import {LitElement, css, html} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import {Analyser} from './analyser';

@customElement('audio-equalizer')
export class AudioEqualizer extends LitElement {
  @property({attribute: false}) inputNode!: AudioNode;
  @property({attribute: false}) outputNode!: AudioNode;

  private inputAnalyser!: Analyser;
  private outputAnalyser!: Analyser;
  private animationFrameId = 0;

  static styles = css`
    :host {
      display: block;
      position: absolute;
      bottom: 40px;
      left: 0;
      right: 0;
      height: 80px;
      z-index: 50;
      pointer-events: none;
    }
    .equalizer-container {
      display: flex;
      justify-content: center;
      align-items: flex-end;
      gap: 6px;
      height: 100%;
      width: 100%;
      padding: 0 20px;
      box-sizing: border-box;
    }
    .bar-wrapper {
      width: 12px;
      height: 100%;
      background-image: linear-gradient(to top, 
        #00ff00 0%, 
        #00ff00 60%, 
        #ffff00 60%, 
        #ffff00 80%, 
        #ff0000 80%, 
        #ff0000 100%
      );
      -webkit-mask-image: repeating-linear-gradient(to top, black 0px, black 4px, transparent 4px, transparent 6px);
      mask-image: repeating-linear-gradient(to top, black 0px, black 4px, transparent 4px, transparent 6px);
      transition: clip-path 0.05s linear;
    }
  `;

  protected firstUpdated() {
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
    this.requestUpdate();
    this.animationFrameId = requestAnimationFrame(this.renderLoop);
  };

  render() {
    if (!this.inputAnalyser || !this.outputAnalyser) return html``;
    
    const inputData = this.inputAnalyser.data;
    const outputData = this.outputAnalyser.data;
    const bars = [];
    
    const numBars = Math.min(inputData.length, outputData.length);
    for (let i = 0; i < numBars; i++) {
      const val = Math.max(inputData[i], outputData[i]);
      const height = Math.max(4, (val / 255) * 100); // 4% min height
      bars.push(html`<div class="bar-wrapper" style="clip-path: inset(calc(100% - ${height}%) 0 0 0);"></div>`);
    }

    const leftBars = [...bars].reverse();
    const allBars = [...leftBars, ...bars];

    return html`
      <div class="equalizer-container">
        ${allBars}
      </div>
    `;
  }
}
