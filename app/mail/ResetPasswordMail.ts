import { Mailable } from '@tylix/mail';

export class ResetPasswordMail extends Mailable {
    constructor(private resetUrl: string) {
        super();
    }

    build() {
        return {
            subject: 'Reset your password',
            view: 'reset-password',
            data: { resetUrl: this.resetUrl },
        };
    }
}