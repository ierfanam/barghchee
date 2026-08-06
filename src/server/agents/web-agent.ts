// src/server/agents/web-agent.ts
import puppeteer from 'puppeteer';

export class WebAgent {
  private browser: any;

  async initialize() {
    this.browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }

  async execute(url: string, formData?: any): Promise<any> {
    if (!this.browser) await this.initialize();
    
    const page = await this.browser.newPage();
    
    try {
      await page.goto(url, { waitUntil: 'networkidle2' });
      
      // تشخیص خودکار فرم‌ها و پر کردن آن‌ها
      if (formData) {
        for (const [key, value] of Object.entries(formData)) {
          const selector = `[name="${key}"], [id="${key}"]`;
          await page.waitForSelector(selector);
          await page.type(selector, value as string);
        }
        
        // کلیک روی دکمه submit
        await page.click('button[type="submit"], input[type="submit"]');
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
      }

      // استخراج اطلاعات مهم از صفحه
      const content = await page.content();
      const title = await page.title();
      
      return {
        success: true,
        url: page.url(),
        title,
        snippet: content.substring(0, 500) // خلاصه محتوا
      };
    } catch (error) {
      console.error('Web Agent Error:', error);
      return { success: false, error: error.message };
    } finally {
      await page.close();
    }
  }

  async loginToElectricSite(username: string, password: string) {
    return this.execute('https://bargh.ilam.ir/login', {
      username,
      password
    });
  }
}