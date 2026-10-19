import { Mailable } from '@tylix/mail';

export interface TeamInviteDetails {
    teamName: string;
    inviterName: string;
    role: string;
    acceptUrl: string;
}

export class TeamInviteMail extends Mailable {
    constructor(private details: TeamInviteDetails) {
        super();
    }

    build() {
        return {
            subject: `${this.details.inviterName} invited you to ${this.details.teamName}`,
            view: 'team-invite',
            data: { ...this.details },
        };
    }
}