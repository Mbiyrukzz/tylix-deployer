import { Mailable } from '@tylix/mail';

export class VerifyEmailMail extends Mailable {
    constructor(private verifyUrl: string) {
        super();
    }

    build() {
        return {
            subject: 'Verify your email',
            view: 'verify-email',
            data: { verifyUrl: this.verifyUrl },
        };
    }
}