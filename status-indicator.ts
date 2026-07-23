import {LitElement, css, html} from 'lit';
import {customElement, property} from 'lit/decorators.js';

@customElement('session-status-indicator')
export class SessionStatusIndicator extends LitElement {
  @property({type: String}) aiState: 'idle' | 'listening' | 'processing' | 'speaking' = 'idle';
  @property({type: Boolean}) isRecording = false;
  @property({type: String}) error = '';

  static styles = css`
    :host {
      display: inline-block;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    }

    .status-badge {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 14px;
      background: rgba(15, 15, 20, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 20px;
      color: #fff;
      font-size: 0.9rem;
      font-weight: 500;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4), inset 0 1px 1px rgba(255, 255, 255, 0.1);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      direction: rtl;
    }

    .status-badge.disconnected {
      border-color: rgba(239, 68, 68, 0.3);
    }

    .status-badge.listening {
      border-color: rgba(99, 102, 241, 0.4);
    }

    .status-badge.processing {
      border-color: rgba(245, 158, 11, 0.4);
    }

    .status-badge.speaking {
      border-color: rgba(16, 185, 129, 0.4);
    }

    .status-dot {
      position: relative;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #94a3b8;
      transition: all 0.3s ease;
    }

    /* Disconnected State */
    .disconnected .status-dot {
      background: #ef4444;
      box-shadow: 0 0 10px rgba(239, 68, 68, 0.6);
    }

    /* Listening State */
    .listening .status-dot {
      background: #6366f1;
      box-shadow: 0 0 12px rgba(99, 102, 241, 0.8);
      animation: pulse-listening 1.5s infinite;
    }

    /* Processing State */
    .processing .status-dot {
      background: #f59e0b;
      box-shadow: 0 0 12px rgba(245, 158, 11, 0.8);
      animation: pulse-processing 1s infinite alternate;
    }

    /* Speaking State */
    .speaking .status-dot {
      background: #10b981;
      box-shadow: 0 0 15px rgba(16, 185, 129, 0.9);
      animation: pulse-speaking 0.8s infinite alternate;
    }

    .status-text {
      font-size: 0.85rem;
      letter-spacing: 0.5px;
      font-weight: 600;
    }

    .status-en {
      font-size: 0.75rem;
      opacity: 0.6;
      margin-right: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    @keyframes pulse-listening {
      0%, 100% {
        transform: scale(1);
        box-shadow: 0 0 8px rgba(99, 102, 241, 0.6);
      }
      50% {
        transform: scale(1.25);
        box-shadow: 0 0 16px rgba(99, 102, 241, 1);
      }
    }

    @keyframes pulse-processing {
      0% {
        opacity: 0.6;
        transform: scale(0.9);
      }
      100% {
        opacity: 1;
        transform: scale(1.15);
        box-shadow: 0 0 14px rgba(245, 158, 11, 1);
      }
    }

    @keyframes pulse-speaking {
      0% {
        transform: scale(0.95);
        box-shadow: 0 0 10px rgba(16, 185, 129, 0.7);
      }
      100% {
        transform: scale(1.3);
        box-shadow: 0 0 18px rgba(16, 185, 129, 1);
      }
    }
  `;

  render() {
    let stateClass = 'disconnected';
    let statusFa = 'غیرفعال / قطع ارتباط';
    let statusEn = 'Disconnected';

    if (this.error) {
      stateClass = 'disconnected';
      statusFa = 'خطا در ارتباط';
      statusEn = 'Error';
    } else if (this.isRecording) {
      if (this.aiState === 'listening') {
        stateClass = 'listening';
        statusFa = 'در حال شنیدن...';
        statusEn = 'Listening';
      } else if (this.aiState === 'processing') {
        stateClass = 'processing';
        statusFa = 'در حال پردازش...';
        statusEn = 'Processing';
      } else if (this.aiState === 'speaking') {
        stateClass = 'speaking';
        statusFa = 'در حال صحبت...';
        statusEn = 'Speaking';
      } else {
        stateClass = 'listening';
        statusFa = 'متصل / آماده';
        statusEn = 'Connected';
      }
    }

    return html`
      <div class="status-badge ${stateClass}">
        <span class="status-dot"></span>
        <span class="status-text">${statusFa}</span>
        <span class="status-en">(${statusEn})</span>
      </div>
    `;
  }
}
