const resendAPIBaseURL = "https://api.resend.com";
const defaultEmailFrom = "BoxHaven <noreply@boxhaven.dev>";

export type EmailServiceOptions = {
  apiKey: string;
  from: string;
  apiURL?: string;
};

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
};

export class EmailService {
  private readonly apiURL: string;

  constructor(private readonly options: EmailServiceOptions) {
    this.apiURL = (options.apiURL || resendAPIBaseURL).replace(/\/+$/, "");
  }

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch(`${this.apiURL}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.options.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Resend POST /emails failed: ${detail || response.statusText}`);
    }
  }
}

export function emailServiceFromEnv(env = process.env): EmailService | undefined {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return undefined;
  return new EmailService({
    apiKey,
    from: env.BOXHAVEN_EMAIL_FROM || defaultEmailFrom,
    apiURL: env.BOXHAVEN_RESEND_API_URL,
  });
}
