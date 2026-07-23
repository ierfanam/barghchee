import React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts';

export class ConsumptionChart extends HTMLElement {
  private root: Root | null = null;
  private _data: any[] = [];

  set data(value: any[]) {
    this._data = value;
    this.renderChart();
  }

  connectedCallback() {
    this.root = createRoot(this);
    this.renderChart();
  }

  disconnectedCallback() {
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
  }

  private renderChart() {
    if (!this.root) return;

    this.root.render(
      <div style={{ width: '100%', height: '300px', padding: '20px', borderRadius: '16px', background: 'rgba(30, 30, 30, 0.8)', backdropFilter: 'blur(10px)', color: 'white', fontFamily: 'system-ui' }}>
        <h3 style={{ margin: '0 0 16px 0', textAlign: 'center', direction: 'rtl' }}>مصرف ۶ ماه اخیر</h3>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={this._data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#444" />
            <XAxis dataKey="month" stroke="#aaa" />
            <YAxis stroke="#aaa" label={{ value: 'کیلووات ساعت (kWh)', angle: -90, position: 'insideLeft', fill: '#aaa' }} />
            <Tooltip 
              contentStyle={{ background: '#333', border: 'none', borderRadius: '8px', color: '#fff' }}
              itemStyle={{ color: '#fff' }}
            />
            <Bar dataKey="kwh" fill="#646cff" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }
}

customElements.define('consumption-chart', ConsumptionChart);
