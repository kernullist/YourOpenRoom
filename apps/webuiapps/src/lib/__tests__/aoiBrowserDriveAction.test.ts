import { describe, expect, it } from 'vitest';
import {
  aoiBrowserDriveIsCaptchaText,
  aoiBrowserDrivePressOnlyMoves,
  classifyAoiBrowserDriveAction,
  namesAnotherExpiringThing,
  normalizeAoiBrowserDriveActionKeys,
  type AoiBrowserDriveActionField,
  type AoiBrowserDriveActionKind,
} from '../aoiBrowserDriveAction';

describe('classifyAoiBrowserDriveAction - read', () => {
  it('classifies observational actions as read (no approval)', () => {
    for (const kind of ['navigate', 'extract', 'scroll', 'screenshot', 'wait', 'back'] as const) {
      const decision = classifyAoiBrowserDriveAction({ kind });
      expect(decision.category).toBe('read');
      expect(decision.requiresApproval).toBe(false);
    }
  });
});

describe('classifyAoiBrowserDriveAction - act', () => {
  it('classifies side-effecting actions as act (approval required)', () => {
    expect(classifyAoiBrowserDriveAction({ kind: 'click', targetText: 'Open settings' })).toEqual({
      category: 'act',
      requiresApproval: true,
      reason: 'side-effecting action requires per-action approval',
    });
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'type',
        text: 'hello',
        field: { type: 'text', name: 'search' },
      }).category,
    ).toBe('act');
    expect(classifyAoiBrowserDriveAction({ kind: 'select', value: 'x' }).category).toBe('act');
    expect(classifyAoiBrowserDriveAction({ kind: 'press', key: 'Enter' }).category).toBe('act');
  });
});

describe('classifyAoiBrowserDriveAction - forbidden: sensitive fields', () => {
  it('blocks typing into password/cc/cvv/otp/ssn fields', () => {
    const cases = [
      { type: 'password' },
      { type: 'text', autocomplete: 'current-password' },
      { type: 'text', autocomplete: 'one-time-code' },
      { type: 'text', name: 'cardNumber' },
      { type: 'text', id: 'cvv' },
      { type: 'text', ariaLabel: 'Social Security Number' },
      { type: 'text', name: 'otp_code' },
    ];
    for (const field of cases) {
      const decision = classifyAoiBrowserDriveAction({ kind: 'type', text: 'x', field });
      expect(decision.category).toBe('forbidden');
      expect(decision.forbidReason).toBe('sensitive_field');
    }
  });

  it('allows typing into an ordinary field', () => {
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'type',
        text: 'kernullist',
        field: { type: 'text', name: 'username' },
      }).category,
    ).toBe('act');
  });
});

describe('classifyAoiBrowserDriveAction - forbidden: financial + captcha', () => {
  it('blocks financial-commit clicks/submits', () => {
    for (const targetText of [
      'Pay now',
      'Place order',
      'Confirm payment',
      'Transfer',
      'Buy now',
      'Withdraw',
      'Trade',
    ]) {
      const decision = classifyAoiBrowserDriveAction({ kind: 'click', targetText });
      expect(decision.category).toBe('forbidden');
      expect(decision.forbidReason).toBe('financial_commit');
    }
    expect(
      classifyAoiBrowserDriveAction({ kind: 'submit', targetText: 'Complete purchase' }).category,
    ).toBe('forbidden');
  });

  it('does not block an ordinary click', () => {
    expect(classifyAoiBrowserDriveAction({ kind: 'click', targetText: 'Reply' }).category).toBe(
      'act',
    );
  });

  it('blocks an order or a payment committed in the words checkouts use', () => {
    for (const targetText of [
      'Place your order',
      'Place the order',
      'Complete order',
      'Confirm your order',
      'Submit order',
      'Finalize order',
      'Order now',
      'Complete payment',
      'Submit payment',
      'Authorize payment',
      'Complete your purchase',
      'Purchase now',
      'Donate now',
      'Proceed to payment',
      'Send tip',
      'Leave a tip',
      'Place bid',
      'Place your bid',
      'Confirm bid',
      'Bid now',
      'Rent now',
    ]) {
      expect(
        classifyAoiBrowserDriveAction({ kind: 'click', targetText }).forbidReason,
        targetText,
      ).toBe('financial_commit');
    }
  });

  it('does not take a list of past orders or purchases for a commit', () => {
    for (const targetText of [
      'Purchase history',
      'Your purchases',
      'Recently purchased',
      'Purchase details',
      'Purchase receipts',
      'Order history',
      'Track your order',
      'Order status',
      'Payment methods',
      'Donations',
      'Pro tip',
      'Tip of the day',
      'Bid farewell to winter',
      'Rental terms',
    ]) {
      expect(
        classifyAoiBrowserDriveAction({ kind: 'click', targetText }).category,
        targetText,
      ).toBe('act');
    }
  });

  it('blocks any interaction with a captcha', () => {
    expect(
      classifyAoiBrowserDriveAction({ kind: 'click', targetText: "I'm not a robot" }).forbidReason,
    ).toBe('captcha');
    expect(
      classifyAoiBrowserDriveAction({ kind: 'type', selector: '#g-recaptcha-response', field: {} })
        .forbidReason,
    ).toBe('captcha');
  });
});

describe('normalizeAoiBrowserDriveActionKeys, and a drag onto a commit control', () => {
  it('reads the snake_case keys the tool schema advertises, a camelCase key first', () => {
    expect(normalizeAoiBrowserDriveActionKeys(null)).toEqual({ kind: 'wait' });
    expect(normalizeAoiBrowserDriveActionKeys('click')).toEqual({ kind: 'wait' });
    expect(normalizeAoiBrowserDriveActionKeys({ kind: 'click' })).toEqual({ kind: 'click' });
    expect(
      normalizeAoiBrowserDriveActionKeys({
        kind: 'drag',
        snapshot_id: 's1',
        to_selector: '#to',
        to_element: 3,
        tab_index: 1,
        prompt_text: 'x',
        file_path: 'C:/f.txt',
        target_text: 'Pay now',
        targetText: 'Buy now',
      }),
    ).toMatchObject({
      kind: 'drag',
      snapshotId: 's1',
      toSelector: '#to',
      toElement: 3,
      tabIndex: 1,
      promptText: 'x',
      filePath: 'C:/f.txt',
      targetText: 'Buy now',
    });
  });

  it('names another thing that expires for the card-group rule', () => {
    for (const words of ['passport number', 'driver license', 'membership id', '여권 번호']) {
      expect(namesAnotherExpiringThing(words), words).toBe(true);
    }
    for (const words of ['card number', 'cvc', 'name on card']) {
      expect(namesAnotherExpiringThing(words), words).toBe(false);
    }
  });

  it('refuses a drag onto a commit control and leaves another drag to approval', () => {
    expect(classifyAoiBrowserDriveAction({ kind: 'drag', targetText: 'Pay now' })).toEqual({
      category: 'forbidden',
      requiresApproval: false,
      reason: 'Dragging onto a financial commit control is never permitted.',
      forbidReason: 'financial_commit',
    });
    expect(
      classifyAoiBrowserDriveAction({ kind: 'drag', targetText: 'Move card to Done' }).category,
    ).toBe('act');
  });
});

describe('classifyAoiBrowserDriveAction - unknown', () => {
  it('fails closed on an unknown kind', () => {
    const decision = classifyAoiBrowserDriveAction({
      kind: 'evaluate' as unknown as AoiBrowserDriveActionKind,
    });
    expect(decision.category).toBe('forbidden');
    expect(decision.forbidReason).toBe('unknown_action');
  });
});

// The patterns were English only, so the same controls on a Korean, Japanese or
// Chinese site were approval-gated at best instead of refused.
describe('classifyAoiBrowserDriveAction - non-English commit and secret labels', () => {
  it('refuses commit buttons labelled in Korean, Japanese and Chinese', () => {
    for (const targetText of [
      '결제하기',
      '바로 구매',
      '주문하기',
      '송금',
      '계좌 이체',
      '購入する',
      '支付',
    ]) {
      const decision = classifyAoiBrowserDriveAction({
        kind: 'click',
        selector: '#go',
        targetText,
      });
      expect(decision.category, targetText).toBe('forbidden');
      expect(decision.forbidReason, targetText).toBe('financial_commit');
    }
  });

  it('refuses typing into fields labelled as secrets in Korean or Japanese', () => {
    for (const ariaLabel of ['비밀번호', '카드 번호', '주민등록번호', 'パスワード']) {
      const decision = classifyAoiBrowserDriveAction({
        kind: 'type',
        selector: '#f',
        text: 'x',
        field: { ariaLabel },
      });
      expect(decision.category, ariaLabel).toBe('forbidden');
      expect(decision.forbidReason, ariaLabel).toBe('sensitive_field');
    }
  });

  it('refuses a Korean captcha and leaves a free subscribe button alone', () => {
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'click',
        selector: '#c',
        targetText: '로봇이 아닙니다',
      }).forbidReason,
    ).toBe('captcha');
    // "구독" on a video site is free; it is not a payment.
    expect(
      classifyAoiBrowserDriveAction({ kind: 'click', selector: '#s', targetText: '구독' }).category,
    ).toBe('act');
  });
});

// press and select used to skip both hard-blocks: Enter submitted a payment form
// as surely as its button would, and a key in a password field typed into it.
describe('classifyAoiBrowserDriveAction - press and select', () => {
  const password = { type: 'password' };

  it('refuses keys that type or submit in a credential field, but not moving away', () => {
    for (const key of ['Enter', 'a', 'Control+V']) {
      const decision = classifyAoiBrowserDriveAction({
        kind: 'press',
        selector: '#pw',
        key,
        field: password,
      });
      expect(decision.forbidReason, key).toBe('sensitive_field');
    }
    for (const key of ['Tab', 'Escape', 'Shift+Tab']) {
      expect(
        classifyAoiBrowserDriveAction({ kind: 'press', selector: '#pw', key, field: password })
          .category,
        key,
      ).toBe('act');
    }
  });

  it('refuses a submitting key whose form commits a payment', () => {
    for (const key of ['Enter', 'Control+Enter', 'Space']) {
      const decision = classifyAoiBrowserDriveAction({
        kind: 'press',
        selector: '#q',
        key,
        targetText: '결제하기',
      });
      expect(decision.forbidReason, key).toBe('financial_commit');
    }
    // A key that does not submit is not a commit.
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'press',
        selector: '#q',
        key: 'ArrowDown',
        targetText: 'Pay now',
      }).category,
    ).toBe('act');
  });

  it('tells a press that only moves from one that could commit or type', () => {
    const press = (key?: string | null) =>
      aoiBrowserDrivePressOnlyMoves({ kind: 'press', selector: '#x', key } as never);
    for (const key of ['Tab', 'Shift+Tab', 'Escape', 'ArrowDown', 'Control+End', 'PageUp']) {
      expect(press(key), key).toBe(true);
    }
    // Enter by default; a typed character; a paste; a modifier alone; no key at all.
    for (const key of [undefined, 'Enter', 'a', 'Control+v', 'Shift', 'Tab+Enter', '', null]) {
      expect(press(key), String(key)).toBe(false);
    }
  });

  it('reads a chord the way Playwright presses it: every key, nothing trimmed', () => {
    const pay = (key: unknown) =>
      classifyAoiBrowserDriveAction({
        kind: 'press',
        selector: '#q',
        key: key as string,
        targetText: 'Pay now',
      });
    // ' ' is the Space key and '\n' is Enter; trimming them made them no key.
    for (const key of [' ', '\n', '\r', 'NumpadEnter', 'Shift+Enter', 'Control+ ']) {
      expect(pay(key).forbidReason, JSON.stringify(key)).toBe('financial_commit');
    }
    // No key at all is Enter, which is what gets pressed.
    expect(pay(undefined).forbidReason).toBe('financial_commit');
    // Playwright holds down EVERY key named, so a chord of two ordinary keys
    // presses both -- the last one is not the only one that counts.
    for (const key of ['Enter+a', 'a+Enter', 'Enter+Tab']) {
      expect(pay(key).forbidReason, key).toBe('unknown_action');
    }
    // A key that is not a key name is refused rather than guessed at.
    expect(pay('').forbidReason).toBe('unknown_action');
    expect(pay(13).forbidReason).toBe('unknown_action');
    // '+' after a modifier is the plus key itself, one key.
    expect(
      classifyAoiBrowserDriveAction({ kind: 'press', selector: '#zoom', key: 'Control++' })
        .category,
    ).toBe('act');
  });

  it('does not let a navigation key carry a typed one into a credential field', () => {
    const decision = classifyAoiBrowserDriveAction({
      kind: 'press',
      selector: '#pw',
      key: 'a+Tab',
      field: password,
    });
    expect(decision.category).toBe('forbidden');
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'press',
        selector: '#pw',
        key: 'Shift',
        field: password,
      }).category,
    ).toBe('act');
  });

  it('knows commit labels in more of the languages it reads', () => {
    for (const label of [
      '今すぐ買う',
      'レジに進む',
      '注文する',
      '決済する',
      '提交订单',
      '去结算',
      '結帳',
      '購買',
      '轉帳',
      '충전하기',
      '선물하기',
    ]) {
      expect(
        classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText: label })
          .forbidReason,
        label,
      ).toBe('financial_commit');
    }
  });

  it('does not take a link to past payments or reviews for a commit', () => {
    for (const label of [
      '결제 내역',
      '결제내역',
      '구매 후기',
      '구매내역',
      '購入履歴',
      '支付宝 登录',
    ]) {
      expect(
        classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText: label })
          .category,
        label,
      ).toBe('act');
    }
  });

  it('knows credential and card fields in more languages, and not look-alikes', () => {
    // An expiry word alone is no longer enough -- see the card expiry tests.
    for (const label of [
      'セキュリティコード',
      '口座番号',
      '卡號',
      '驗證碼',
      '安全码',
      'totpCode',
      'otp_input',
      'smsOtp',
      'verifyOtpCode',
      'Expiration date (MM/YY)',
      'MM / YY',
      'Verification code',
      'Enter the verification number',
      'Verify code',
      'Authenticator code',
      'Authentication code',
      'Auth code',
      '2FA',
      'Two-factor code',
      'SMS code',
      'Texted code',
      'Emailed code',
      'Backup code',
      'Recovery codes',
      'CVV2',
      'CVC2',
      '認証コード',
      '認証番号',
      'ワンタイムパスワード',
    ]) {
      expect(
        classifyAoiBrowserDriveAction({
          kind: 'type',
          selector: '#f',
          text: '1',
          field: { ariaLabel: label },
        }).forbidReason,
        label,
      ).toBe('sensitive_field');
    }
    for (const label of [
      'passengers',
      'Number of passengers',
      'passengerName',
      'footprint',
      '암호화폐 지갑 이름',
      'Experience',
      'Export file name',
      'Expected delivery',
      'Email address for verification',
      'Authentication method',
      'Booking confirmation number',
      'SMS notifications',
      'Access code for the building',
    ]) {
      expect(
        classifyAoiBrowserDriveAction({
          kind: 'type',
          selector: '#f',
          text: '2',
          field: { ariaLabel: label },
        }).category,
        label,
      ).toBe('act');
    }
  });

  it('refuses answering a prompt that asks for a secret, but not dismissing it', () => {
    const prompt = (disposition: string, promptText?: string) =>
      classifyAoiBrowserDriveAction({
        kind: 'dialog',
        disposition,
        ...(promptText !== undefined ? { promptText } : {}),
        targetText: 'Enter the one-time code we sent you',
      });
    expect(prompt('accept', '493817').forbidReason).toBe('sensitive_field');
    expect(prompt('dismiss', '493817').category).toBe('act');
    // Accepting without typing anything types no secret.
    expect(prompt('accept').category).toBe('act');
    expect(prompt('accept', '').category).toBe('act');
  });

  it('refuses a download that would click a commit control', () => {
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'download',
        selector: '#buy',
        filePath: 'C:/Downloads',
        targetText: 'Buy now',
      }).forbidReason,
    ).toBe('financial_commit');
  });

  it('refuses a key that chooses in a field holding a secret, but not one that leaves it', () => {
    // An arrow key picks a card's expiry month in a select as surely as
    // choosing it does.
    const field = { autocomplete: 'cc-exp-month' };
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'Shift+ArrowDown']) {
      expect(
        classifyAoiBrowserDriveAction({ kind: 'press', selector: '#m', key, field }).forbidReason,
        key,
      ).toBe('sensitive_field');
    }
    for (const key of ['Tab', 'Shift+Tab', 'Escape']) {
      expect(
        classifyAoiBrowserDriveAction({ kind: 'press', selector: '#m', key, field }).category,
        key,
      ).toBe('act');
    }
    // In any other field an arrow only moves.
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'press',
        selector: '#q',
        key: 'ArrowDown',
        field: { name: 'q' },
      }).category,
    ).toBe('act');
  });

  it('refuses choosing an option in a payment field', () => {
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'select',
        selector: '#exp',
        value: '12',
        field: { autocomplete: 'cc-exp-month' },
      }).forbidReason,
    ).toBe('sensitive_field');
    expect(
      classifyAoiBrowserDriveAction({ kind: 'select', selector: '#size', value: 'M' }).category,
    ).toBe('act');
  });
});

// A review found captchas, commits and secrets that were let through, and
// ordinary controls that were refused. These lists are its cases.
describe('classifyAoiBrowserDriveAction - captchas that never say "captcha"', () => {
  it('refuses a human check in the words it uses', () => {
    for (const targetText of [
      'Verify you are human',
      "Verify that you're a human",
      'Verifying you are human. This may take a few seconds.',
      'Confirm you are human',
      'Are you a robot?',
      'I am human',
      'Human verification required',
      'Widget containing a Cloudflare security challenge',
      'Slide right to verify',
      'Slide to complete the puzzle',
      '캡차 입력',
      '사람인지 확인해 주세요',
      '画像認証',
      '人間であることを確認します',
      '向右滑动完成验证',
      '请完成安全验证',
      '拖动滑块完成拼图',
      '完成驗證',
      '滑动验证',
      '滑動驗證',
      '拼圖驗證',
      '拖動滑塊完成拼圖',
    ]) {
      expect(
        classifyAoiBrowserDriveAction({ kind: 'click', selector: '#c', targetText }).forbidReason,
        targetText,
      ).toBe('captcha');
    }
    // Its name in the selector counts as much as its words.
    expect(
      classifyAoiBrowserDriveAction({ kind: 'click', selector: '#security-challenge' })
        .forbidReason,
    ).toBe('captcha');
  });

  it('does not take a control that shares a word with one for a captcha', () => {
    for (const targetText of [
      'Verify your email',
      'Human resources',
      'Security settings',
      '向右滑动查看更多',
      '音量滑块',
      'Are you sure?',
      'I am a teacher',
      'Slide to unlock',
      '安全设置',
    ]) {
      expect(
        classifyAoiBrowserDriveAction({ kind: 'click', selector: '#c', targetText }).category,
        targetText,
      ).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a confirm() that says what it charges', () => {
  const dialog = (disposition: string, targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition, targetText });

  it('refuses accepting a charge, a deduction or a send, but not backing out of it', () => {
    for (const message of [
      'Your card ending in 4242 will be charged $49.00. Continue?',
      "You'll be charged $9.99/month after your trial. Start trial?",
      'Proceed with the payment of $49.00?',
      'Send $50.00 to Alice Kim?',
      '$49.00 will be deducted from your wallet balance',
      'You will be charged €12 monthly',
      'We will charge 49 USD to your card. OK?',
      '₩49,000이 청구됩니다. 계속할까요?',
      '49,000원이 차감됩니다',
      '¥4,900が請求されます',
      '将扣除 ¥49',
      '确认扣款?',
    ]) {
      expect(dialog('accept', message).forbidReason, message).toBe('financial_commit');
      expect(dialog('dismiss', message).category, message).toBe('act');
    }
  });

  it('accepts a confirm that moves no money', () => {
    for (const message of [
      'Delete this item?',
      'Remove debit card ending 4242?',
      'Leave this page?',
      'Charge your phone now?',
      'Discard changes?',
      'You will not be charged again. Cancel subscription?',
    ]) {
      expect(dialog('accept', message).category, message).toBe('act');
    }
  });

  it('reads what a confirm says only in a confirm', () => {
    // On a link the same words are a help page or a statement, not a commit.
    for (const words of ['Why was I charged $9.99?', 'Amount deducted last month']) {
      expect(
        classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText: words })
          .category,
        words,
      ).toBe('act');
      expect(dialog('accept', words).forbidReason, words).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - more ways to commit money', () => {
  it('refuses wallet, bet, pledge, rental and checkout commits in four languages', () => {
    for (const targetText of [
      'Continue to payment',
      'Check out',
      'Check out now',
      'Check out with PayPal',
      'Rent HD $5.99',
      'Rent for $3.99',
      'Rent $3.99',
      'Top up',
      'Top-up',
      'Topup',
      'Add funds',
      'Cash out',
      'Cashout',
      'Place bet',
      'Bet now',
      'Confirm swap',
      'Pledge $10',
      'Pledge now',
      'Back this project',
      'Give now',
      'Send $25.00',
      'Send US$25',
      'Transfer',
      'Transfer $50',
      'Withdraw funds',
      'Deposit',
      'Deposit now',
      'Buy',
      'Buy HD',
      'Buy It Now',
      'Checkout',
      'Proceed to checkout',
      'Secure checkout',
      '결제하기',
      '결제 진행',
      '결제',
      '바로 결제',
      '기부하기',
      '후원하기',
      '입찰하기',
      '베팅하기',
      '환전하기',
      '入札する',
      '寄付する',
      '投げ銭',
      'ベットする',
      '売却する',
      '売る',
      '買い付け',
      '注文確定',
      '出金する',
      '入金する',
      'チャージする',
      '支払う',
      'お支払い',
      'お支払いへ進む',
      '提现',
      '提款',
      '充值',
      '儲值',
      '加值',
      '捐款',
      '捐赠',
      '捐贈',
      '打赏',
      '打賞',
      '出价',
      '出價',
      '投注',
      '下注',
      '卖出',
      '賣出',
      '买入',
      '買入',
      '立即抢购',
      '立即搶購',
      '立即订购',
      '立即訂購',
      '立即下單',
      '結算',
      '结帐',
      '确认订单',
      '確認訂單',
      '立即支付',
      '确认付款',
    ]) {
      expect(
        classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText }).forbidReason,
        targetText,
      ).toBe('financial_commit');
    }
  });

  it('does not take a link that only lists or explains for a commit', () => {
    for (const targetText of [
      'Order history',
      'Track your order',
      'Purchase history',
      'Transfer history',
      'Withdrawal history',
      'Deposit history',
      'Buy it again',
      'Buy again',
      'How to buy',
      'Where to buy',
      'Checkout help',
      'Check out our new arrivals',
      'Check out another color',
      'Check-out date',
      '附加值服务',
      'Top-up history',
      'Back to top',
      'Add credit card',
      'Cashout history',
      'Pro tip',
      'Rent apartments',
      'Tip of the day',
      'Bid history',
      '결제 내역',
      '결제수단 관리',
      '결제 방법',
      '결제 정보',
      '결제 안내',
      'お支払い方法',
      'お支払い履歴',
      '支付方式',
      '支付记录',
      '付款方式',
      '付款记录',
      '提现记录',
      '充值记录',
      '出价记录',
      '入札履歴',
      '出金履歴',
      '入金履歴',
      '売却益',
      '支付宝',
    ]) {
      expect(
        classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText }).category,
        targetText,
      ).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - identity numbers and codes by other names', () => {
  it('refuses typing a card code, an identity number or a sign-in code', () => {
    for (const label of [
      'Card Code',
      'Card verification value',
      'Card security code',
      'CSC',
      'CVN',
      "Driver's license number",
      'Drivers license',
      'Driving licence number',
      'National ID number',
      'Tax ID',
      'Taxpayer ID',
      'Passport number',
      'Login code',
      'Sign-in code',
      '여권번호',
      '운전면허번호',
      '외국인등록번호',
      '인증코드',
      'マイナンバー（個人番号）',
      '運転免許証番号',
      'パスポート番号',
      '旅券番号',
      '確認コード',
      '身份证号',
      '身份證字號',
      '身分證字號',
      '护照号码',
      '護照號碼',
      '动态码',
      '動態碼',
      '校验码',
      '校驗碼',
    ]) {
      expect(
        classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field: { label } })
          .forbidReason,
        label,
      ).toBe('sensitive_field');
    }
  });

  it('refuses attaching an identity document', () => {
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'upload',
        selector: '#id',
        filePath: 'C:/work/id.png',
        field: { label: "Driver's license or national ID card (front)" },
      }).forbidReason,
    ).toBe('sensitive_field');
  });

  it('does not take a promo code or a name for a secret', () => {
    for (const label of [
      'Promo code',
      'Discount code',
      'Coupon code',
      'Card holder name',
      'Cardholder name',
      'National park',
      'Gift message',
      'Postal code',
      'ZIP code',
      'Syntax ID',
      '予約確認コード',
    ]) {
      expect(
        classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '2', field: { label } })
          .category,
        label,
      ).toBe('act');
    }
  });
});

// An expiry word on its own refused a coupon's expiry, a link's expiration and
// a job's start month; it is a card detail only beside a card.
describe('classifyAoiBrowserDriveAction - a card expiry, and other expiries', () => {
  const enter = (kind: 'type' | 'select', field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind, selector: '#f', text: '1', value: '1', field });

  it('refuses entering or choosing an expiry beside a card', () => {
    for (const field of [
      { label: 'Expiry date', id: 'card-expiry' },
      { ariaLabel: 'Expiration date', label: 'Card details Expiration date' },
      { placeholder: 'MM/YY' },
      { label: 'Card expiry' },
      { label: '카드 유효기간' },
      { label: 'カード有効期限' },
      { label: '信用卡有效期' },
      { autocomplete: 'cc-exp-month' },
      { ariaLabel: 'Expiration month', name: 'cc_exp_month' },
      { ariaLabel: 'Exp. year', id: 'cc-exp-year' },
      { ariaLabel: 'Expiry date', name: 'debitExpiry' },
      { ariaLabel: '有効期限', label: 'カード情報' },
      { ariaLabel: '유효기간', name: 'cardExpiry' },
    ]) {
      for (const kind of ['type', 'select'] as const) {
        expect(enter(kind, field).forbidReason, `${kind} ${JSON.stringify(field)}`).toBe(
          'sensitive_field',
        );
      }
    }
  });

  it('does not take a coupon, a link or a start month for a card expiry', () => {
    for (const field of [
      { label: 'Coupon expiry date' },
      { label: 'Link expiration' },
      { label: 'Start date', placeholder: 'MM/YYYY' },
      { label: '쿠폰 유효기간' },
      { label: 'ポイント有効期限' },
    ]) {
      for (const kind of ['type', 'select'] as const) {
        expect(enter(kind, field).category, `${kind} ${JSON.stringify(field)}`).toBe('act');
      }
    }
  });
});

// India's postal "PIN code" is an address; a PIN is still a secret.
describe('classifyAoiBrowserDriveAction - a PIN, and a postal PIN code', () => {
  const typeInto = (field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field });

  it('refuses a PIN, and a PIN by another name beside a postal word', () => {
    for (const field of [
      { label: 'Card PIN' },
      { label: 'PIN' },
      { name: 'pincode', label: 'Verification PIN' },
    ]) {
      expect(typeInto(field).forbidReason, JSON.stringify(field)).toBe('sensitive_field');
    }
  });

  it('does not take a postal PIN code for a PIN', () => {
    for (const field of [
      { label: 'Pincode', placeholder: '6 digits [0-9] PIN code' },
      { label: 'ZIP / PIN code' },
      { autocomplete: 'postal-code', placeholder: 'PIN code' },
    ]) {
      expect(typeInto(field).category, JSON.stringify(field)).toBe('act');
    }
  });

  it('reads a prompt() the way it reads a field', () => {
    const prompt = (targetText: string) =>
      classifyAoiBrowserDriveAction({
        kind: 'dialog',
        disposition: 'accept',
        promptText: '1234',
        targetText,
      });
    expect(prompt('Enter your PIN').forbidReason).toBe('sensitive_field');
    expect(prompt('Enter your ZIP / PIN code').category).toBe('act');
    expect(prompt("Enter your card's expiry date").forbidReason).toBe('sensitive_field');
    expect(prompt("Enter the coupon's expiry date").category).toBe('act');
    // A prompt that says nothing names no secret.
    expect(
      classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', promptText: '1234' })
        .category,
    ).toBe('act');
  });
});

// A confirm() bills in more words than "charged", and a cancel confirm names
// the very charge it stops -- so a negated billing clause is read as what it
// is, and a billing word counts only beside an amount or worded as a bill.
describe('classifyAoiBrowserDriveAction - a confirm() that bills, and one that stops billing', () => {
  const dialog = (disposition: string, targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition, targetText });

  it('refuses accepting a bill, worded with or without an amount, but not backing out', () => {
    for (const message of [
      'You will be billed $49.00 today and every year after that. Continue?',
      'Your total today is $49.00 (billed annually). Continue?',
      '本日、年額4,900円を請求します。よろしいですか？',
      '将向您收取 ¥49.00 年费，确定继续吗？',
      '₩9,900이 과금됩니다',
      '매월 9,900원이 부과됩니다',
      '청구될 예정입니다',
      '課金されます。よろしいですか？',
      '毎月引き落とします',
      '請求いたします',
      '将扣费 ¥9',
      'Confirm subscription: $9.99/month',
      'This will cost $49.00. Continue?',
      'A $5 fee applies. Continue?',
      '$49.00 will be deducted from your wallet balance',
      'The amount will be deducted from your account',
      "You'll be billed on March 3",
      'Your plan renews at $9.99 per month',
      'You will be charged monthly',
    ]) {
      expect(dialog('accept', message).forbidReason, message).toBe('financial_commit');
      expect(dialog('dismiss', message).category, message).toBe('act');
    }
  });

  it('does not take a cancel confirm, a points deduction or a count for a bill', () => {
    for (const message of [
      'Cancel your subscription? You will no longer be charged on the 1st of each month.',
      "Turn off auto-renew? You won't be charged on March 3.",
      'You will not be charged $9.99',
      'You will not be charged 9.99 EUR per month',
      'Your subscription will not be renewed. Continue?',
      '500 points will be deducted',
      'Delete this item?',
      'Remove debit card ending 4242?',
      'Charge your phone now?',
      '더 이상 청구되지 않습니다. 해지할까요?',
      '今後は請求されません。解約しますか？',
      '不会再扣费，确定取消吗？',
      'Your total is 3 items',
      'Delete 3 bills?',
    ]) {
      expect(dialog('accept', message).category, message).toBe('act');
    }
  });

  it('takes out a negated clause only to the end of its sentence', () => {
    // What the next sentence (or the next line) bills is still read.
    for (const message of [
      "You won't be charged today. Your card will be charged $49.00 on March 3.",
      'Your plan will not be renewed\nYou will be charged a $10 fee',
      'Cancel subscription? You will no longer be charged. Confirm the $5 fee?',
      '더 이상 청구되지 않습니다. ₩9,900이 과금됩니다',
      'You will not be charged again. Place order?',
    ]) {
      expect(dialog('accept', message).forbidReason, message).toBe('financial_commit');
    }
    // A negation needs its billing word within a few words, and only letters
    // between them: these bill.
    for (const message of [
      'No more than $50 will be charged.',
      'If you do not cancel, you will be charged $9.99',
      'Do not close this window or you will be charged twice',
    ]) {
      expect(dialog('accept', message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('counts a deduction only beside an amount or out of an account', () => {
    for (const message of [
      'Your account will be debited $49',
      '49 USD will be debited',
      'The amount will be debited from the card',
      'Deducted from your bank: see the receipt',
    ]) {
      expect(dialog('accept', message).forbidReason, message).toBe('financial_commit');
    }
    for (const message of ['Your account will be debited', 'Points deducted: 500']) {
      expect(dialog('accept', message).category, message).toBe('act');
    }
  });

  it('finds an amount within forty characters of a billing word, on either side', () => {
    // Not letters: an amount may start with two of them ("US$9").
    const gap = (length: number) => '-'.repeat(length);
    expect(dialog('accept', `fee ${gap(39)}$9`).forbidReason).toBe('financial_commit');
    expect(dialog('accept', `$9${gap(39)} fee`).forbidReason).toBe('financial_commit');
    expect(dialog('accept', `fee ${gap(40)}$9`).category).toBe('act');
    expect(dialog('accept', `$9${gap(40)} fee`).category).toBe('act');
    // The nearest of the other kind is what counts, wherever it falls.
    expect(dialog('accept', `fee ${gap(60)} $1 ${gap(60)} $2 fee`).forbidReason).toBe(
      'financial_commit',
    );
    expect(dialog('accept', `$1 ${gap(60)} fee ${gap(60)} 청구 ${gap(60)} $2`).category).toBe(
      'act',
    );
  });

  it('reads a billing word only in a dialog, never on a button', () => {
    for (const words of ['Confirm subscription: $9.99/month', 'A $5 fee applies']) {
      expect(
        classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText: words })
          .category,
        words,
      ).toBe('act');
    }
  });

  it('accepts nothing when a dialog step says no answer at all', () => {
    // No disposition is not "accept": nothing is agreed to, a bill or a prompt.
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'dialog',
        targetText: 'Your card will be charged $49.00. Continue?',
      }).category,
    ).toBe('act');
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'dialog',
        promptText: '493817',
        targetText: 'Enter the code we emailed you',
      }).category,
    ).toBe('act');
  });
});

describe('classifyAoiBrowserDriveAction - one-time codes and account numbers by other names', () => {
  const typeInto = (label: string) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field: { label } });

  it('refuses typing a one-time code or an account or card number', () => {
    for (const label of [
      'MFA code',
      'Enter the code we emailed you',
      'Enter the code that was just sent',
      'Code sent to your phone',
      'MFA token',
      'Authenticator app code',
      'Code from your authenticator app',
      'Email code',
      'E-mail code',
      'Text code',
      'Login approval code',
      '动态口令',
      '動態口令',
      '短信验证',
      '短信驗證',
      '확인 코드',
      '확인코드',
      'Account #',
      'Acct #',
      'Account no.',
      'Acct. num',
      'CC number',
      'CC #',
      'Card #',
      '银行账号',
      '銀行帳號',
      '银行卡号',
      '銀行卡號',
    ]) {
      expect(typeInto(label).forbidReason, label).toBe('sensitive_field');
    }
  });

  it('does not take a booking, a dialling or a promo code, or an account name, for a secret', () => {
    for (const label of [
      '예약 확인 코드',
      '예약확인코드',
      'Phone code',
      'Promo code',
      'Zip code',
      'Account name',
      'Account type',
      'Account notes',
      'Order #',
      'Country code',
      'Context code',
    ]) {
      expect(typeInto(label).category, label).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a passport, a license or an ID card named but not asked for', () => {
  const typeInto = (field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field });
  const uploadTo = (field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({
      kind: 'upload',
      selector: '#f',
      filePath: 'C:/work/id.png',
      field,
    });

  it('still refuses the number, the document and every password', () => {
    for (const label of [
      'Passport number',
      'Passport',
      'Passport No.',
      "Driver's license number",
      'Drivers license',
      '身份证号',
      '身分證字號',
      'Password',
      'Passcode',
      'New password',
    ]) {
      expect(typeInto({ label }).forbidReason, label).toBe('sensitive_field');
    }
    for (const label of ['Passport photo page', "Driver's license or national ID card (front)"]) {
      expect(uploadTo({ label }).forbidReason, label).toBe('sensitive_field');
    }
  });

  it('does not take a name as written on one, or its country, date or state, for it', () => {
    for (const field of [
      { label: 'First name (as shown on passport)' },
      { label: 'Last name as in your passport' },
      { label: 'Passport issuing country' },
      { label: 'Passport expiry date' },
      { name: 'passportExpiry' },
      { name: 'passport_country' },
      { label: 'Passport nationality' },
      { label: "Driver's license status" },
      { label: "Driver's license state" },
      { label: "Driver's licence class" },
      { name: 'drivers_license_state' },
      { label: '真实姓名（与身份证一致）' },
    ]) {
      expect(typeInto(field).category, JSON.stringify(field)).toBe('act');
    }
  });
});

// What a field sits among decides an expiry and a PIN, and nothing else.
describe('classifyAoiBrowserDriveAction - what a field sits among', () => {
  const enter = (kind: 'type' | 'select', field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind, selector: '#f', text: '1', value: '1', field });

  it('refuses an expiry among a card, and a secret PIN among an address', () => {
    expect(enter('select', { label: 'Expiration date', near: 'card' }).forbidReason).toBe(
      'sensitive_field',
    );
    expect(enter('type', { label: 'Expiry', near: 'card address' }).forbidReason).toBe(
      'sensitive_field',
    );
    for (const label of ['ATM PIN', 'Card PIN code', 'SIM PIN code', 'Bank account PIN code']) {
      expect(enter('type', { label, near: 'address' }).forbidReason, label).toBe('sensitive_field');
    }
  });

  it('lets a postal PIN code among an address and a coupon expiry through', () => {
    expect(enter('type', { label: 'PIN Code', name: 'pin_code', near: 'address' }).category).toBe(
      'act',
    );
    // Without an address around it, a bare "PIN Code" is still a PIN.
    expect(enter('type', { label: 'PIN Code', name: 'pin_code' }).forbidReason).toBe(
      'sensitive_field',
    );
    expect(enter('select', { label: 'Expiration date' }).category).toBe('act');
    expect(enter('type', { label: 'Coupon expiry date', near: 'address' }).category).toBe('act');
  });

  it('never reads what is around a field as the field itself', () => {
    for (const near of ['card password', 'otp captcha', 'address card']) {
      expect(enter('type', { label: 'Nickname', near }).category, near).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - click and slider captchas', () => {
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#c', targetText });

  it('refuses a click or slider check in the words it uses', () => {
    for (const text of [
      '点击按钮进行验证',
      '点击开始验证',
      '點擊按鈕進行驗證',
      'Click to verify',
      '确认您是真人',
      '確認你是真人',
      '请按住滑块，拖动到最右边',
      '按住滑塊',
      '拖动下方滑块完成拼图',
      '拖動下方滑塊完成驗證',
      '进行人机身份验证',
      '人機身份驗證',
      "Let's confirm you are human",
    ]) {
      expect(click(text).forbidReason, text).toBe('captcha');
      expect(aoiBrowserDriveIsCaptchaText(text), text).toBe(true);
    }
  });

  it('does not take a setting, a slider or an email check for a captcha', () => {
    for (const text of [
      'Update security challenge questions',
      'Security challenge question 1',
      '音量滑块',
      '拖动滑块调整价格',
      'Verify your email',
      'Click to verify your email',
      'Human resources',
      'Slide to unlock',
    ]) {
      expect(click(text).category, text).toBe('act');
      expect(aoiBrowserDriveIsCaptchaText(text), text).toBe(false);
    }
  });

  it('reads only text', () => {
    expect(aoiBrowserDriveIsCaptchaText('')).toBe(false);
    expect(aoiBrowserDriveIsCaptchaText(undefined as unknown as string)).toBe(false);
    expect(aoiBrowserDriveIsCaptchaText(42 as unknown as string)).toBe(false);
  });
});

describe('classifyAoiBrowserDriveAction - check out, value-added services and lists', () => {
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('refuses "check out" where it plainly commits', () => {
    for (const targetText of [
      'Check out',
      'Check out now',
      'Check out securely',
      'Check out with PayPal',
      'Check out as guest',
      'Check out as a guest',
      'Check out (2 items)',
      'Check out $49.00',
      'Check out »',
      'Check out →',
      'Check out Check out',
      'Proceed to check out',
      'Check out?',
    ]) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });

  it('does not take a link, a hotel day or a check-out time for a commit', () => {
    for (const targetText of [
      'Check out / Add dates',
      'Check out Tue, Oct 14',
      'Check out branch',
      'Check out reviews',
      'Check out deals',
      'Check out our new arrivals',
      'Check-out date',
      'Check out time',
      'Check out date',
      'Checkout date',
      'Checkout time',
      'Checkout day',
      'Check out another color',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });

  it('refuses a top-up but not a value-added service or VAT', () => {
    for (const targetText of ['加值', '立即加值']) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
    for (const targetText of ['加值服務', '加值服务', '加值型', '加值稅', '加值税', '附加值服务']) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });

  it('still refuses CJK commits, but not the lists, payees and limits beside them', () => {
    for (const targetText of [
      '送金する',
      '振込する',
      '決済する',
      '购买',
      '转账',
      '이체하기',
      '송금하기',
      '출금',
      '입금',
      '購買',
      '轉帳',
    ]) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
    for (const targetText of [
      '決済方法の変更',
      '決済手段',
      '送金履歴',
      '振込先',
      '振込口座',
      '购买记录',
      '购买须知',
      '購買紀錄',
      '转账明细',
      '轉帳紀錄',
      '이체내역조회',
      '송금 내역',
      '출금 한도',
      '입금 확인',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });
});

// A negation used to take out the rest of its sentence, so a commit later in
// the same sentence went with it. Now only the negated phrase is taken out for
// the phrases, and only its clause for the amounts.
describe('classifyAoiBrowserDriveAction - a negation takes out only what it negates', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('still reads what the rest of a negated sentence commits', () => {
    for (const message of [
      "You won't be charged any extra fees when you pay $49.00 now with your saved card. Continue?",
      'You will not be charged twice, but $49.00 will be charged now. Continue?',
      'Your monthly plan will not be renewed; instead, your card will be charged $99.00 today.',
      "You won't be billed again: buy the lifetime plan for $199.00 now?",
      '추가 수수료는 청구되지 않으며, 지금 49,000원이 결제됩니다. 계속할까요?',
      '追加料金は請求されませんが、今すぐ4,900円を支払います。よろしいですか？',
      '不会再扣费，立即支付 ¥49.00？',
      "You won't be charged a fee; $49.00 will be taken from your card.",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('ends a negated clause at its punctuation, a dash or a turn of the sentence', () => {
    // Each of these bills a fee in a clause of its own.
    for (const message of [
      "You won't be billed twice; however, the $5 fee still applies.",
      "You won't be charged twice: a $5 fee applies.",
      "You won't be charged twice - a $5 fee applies.",
      "You won't be charged twice – a $5 fee applies.",
      "You won't be charged twice—a $5 fee applies.",
      "You won't be charged twice, but a $5 fee applies.",
      "You won't be charged twice, yet a $5 fee applies.",
      "You won't be charged twice, instead a $5 fee applies.",
      "You won't be charged twice\na $5 fee applies.",
      '추가 요금은 청구되지 않습니다、월 요금 9,900원',
      '不会再扣费，年费 ¥49.00',
      '請求されません：料金 4,900円',
    ]) {
      expect(accept(message).forbidReason, JSON.stringify(message)).toBe('financial_commit');
    }
  });

  it('lets through what a negated clause says will not be billed', () => {
    for (const message of [
      'You will no longer be charged $9.99/month.',
      "You won't be charged on March 3.",
      'Cancel your subscription? You will no longer be charged on the 1st of each month.',
      // An ASCII comma ends no clause -- an accepted trade-off for the first.
      "You won't be charged until your trial ends, then $9.99/month.",
      "You won't be charged for this change, and your plan stays at $9.99/month.",
      // Nor does the point in an amount, or a hyphen not set apart by spaces.
      "You won't be charged the $9.99 auto-renewal fee.",
      "You won't be charged twice -a $5 fee applies.",
      'You have not yet been charged $49.00',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - "check out" before a price or an arrow', () => {
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('refuses a check out with an amount behind a separator, or with an arrow glyph', () => {
    for (const targetText of [
      'Check out - $49.00',
      'Check out – $49.00',
      'Check out — $49.00',
      'Check out · $49.00',
      'Check out • $49.00',
      'Check out | $49.00',
      'Check out: $49.00',
      'Check out, $49.00',
      'Check out ▸',
      'Check out ▶',
      'Check out ►',
      'Check out ➔',
      'Check out ➜',
    ]) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });

  it('still takes a separator before no amount for a link or a hotel day', () => {
    for (const targetText of [
      'Check out / Add dates',
      'Check out: 2 items',
      'Check out Tue, Oct 14',
      'Check out - Tue, Oct 14',
      'Check out · 2 nights',
      'Check out reviews',
      'Check out branch',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - commit wordings that were missing', () => {
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses approving or scheduling a payment, a donation, an offer and money with its amount', () => {
    for (const targetText of [
      'Schedule payment',
      'Approve payment',
      'Release payment',
      'Retry payment',
      'Initiate the payment',
      'Complete donation',
      'Make a donation',
      'Give $25',
      'Give CA$25',
      'Contribute $10',
      'Invest $1,000',
      'Convert now',
      'Invest now',
      'Tip $5',
      'Bid US $12.50',
      'Submit offer',
      'Schedule payments',
      'Submit an offer',
      'Send Jane Doe $49.00',
      'Send $25.00',
      'Authorize US $49.00',
    ]) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });

  it('refuses a confirm that takes money, names a transaction of an amount or a total', () => {
    for (const message of [
      '£49.00 will be taken from your account today.',
      'Confirm your donation of $25.00 to Save the Whales?',
      'Authorize $49.00 to ACME Corp?',
      'Confirm this transaction of $49.00?',
      'A withdrawal of $200.00 will be made.',
      'Total: $49.00. Proceed?',
      'Total due = $49.00',
      'Your total today is $49.00. Continue?',
      'Send Jane Doe $49.00?',
      'Tip $5.00 to your driver?',
      'Bid US $25.00 on this item?',
      // A total stopped beside something that starts: bought.
      'Remove the trial and start your plan? Your new total is $39.00.',
      // The until a negation takes ends at a comma.
      "You won't be charged until today, pay $49.00 now?",
      // 月額 and 年額 are rates.
      '月額980円で登録しますか？',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('lets a confirm say what a stopped amount was, and what a later commit will be', () => {
    for (const message of [
      'Remove this item? Your new total is $39.00.',
      'Delete this transaction of $49.00?',
      'Cancel order? Your total of $49.00 will be refunded.',
      "Your card won't be charged until you place your order. Continue?",
      "You won't be charged until you confirm your purchase.",
      "You won't be charged; you'll pay nothing today. Start trial?",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('does not take feedback, a tip of the day, a form or a reminder for a commit', () => {
    for (const targetText of [
      'Send invoice for $49.00',
      'Send reminder for $49.00 invoice',
      'Send request for $20',
      'Give $10, get $10',
      'Give $10 and get $10',
      'Submit offer letter',
      'Schedule payments overview',
      'Give feedback',
      'Tip of the day',
      'Pro tip',
      'Bid farewell',
      'Submit',
      'Submit form',
      'Convert to PDF',
      'Convert units',
      'Invest in yourself',
      'Send',
      'Send message',
      'Send a reminder to Jane about the $49.00 invoice',
      'Approve request',
      'Schedule a call',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
    for (const message of [
      'Your cart has 3 items. Total items: 3. Continue?',
      'Total refund: $49.00',
      'Send a reminder to Jane about the $49.00 invoice?',
      'Remove this item from your list?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a code named for what it is', () => {
  const typeInto = (label: string) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field: { label } });

  it("still refuses a one-time code however it arrived, and a card's code, number or PIN", () => {
    for (const label of [
      'Enter the code we emailed you',
      'Code sent to your phone',
      'Email code',
      'Text code',
      'Confirmation code we texted you',
      'Verification code',
      'Card code',
      'Gift card number',
      'Gift card PIN',
    ]) {
      expect(typeInto(label).forbidReason, label).toBe('sensitive_field');
    }
  });

  it('takes an access code sent to a phone for one, as some banks call theirs', () => {
    for (const label of [
      'Room access code sent to your phone',
      'Enter the access code we texted you',
    ]) {
      expect(typeInto(label).forbidReason, label).toBe('sensitive_field');
    }
  });

  it('does not take a discount, referral, booking or gift card code for one', () => {
    for (const label of [
      'Discount code we emailed you',
      'Referral code sent to you by a friend',
      'Invitation code that was sent to your email',
      'Coupon code we texted you',
      'Booking confirmation code we emailed you',
      'Order confirmation code sent to your email',
      'Promo code',
      'Promotional email code',
      'Gift card code sent to your email',
      'Gift card code',
      'eGift card code',
    ]) {
      expect(typeInto(label).category, label).toBe('act');
    }
  });
});

// A stopping confirm quotes the price of what it stops; a rate beside it is
// not a bill, while a charge still is.
describe('classifyAoiBrowserDriveAction - a cancel or turn-off confirm that quotes a price', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('still refuses a charge, a fee or a sale beside a price', () => {
    for (const message of [
      'Cancel your plan? A $10 cancellation fee applies.',
      'Cancel now? You will be charged $10.',
      'Cancel your plan? $10 will be debited.',
      'Delete your account? Outstanding bills of $20 remain.',
      '해지하시겠습니까? 위약금 10,000원이 청구',
      'Subscribe to Premium for $9.99/month?',
      'Upgrade to Pro for $9.99/month?',
      'Confirm subscription: $9.99/month',
      // A reassurance stops nothing, and an action with a price is bought.
      'Subscribe for $9.99/month? Cancel anytime.',
      'You can cancel at any time. Join for $4.99/month?',
      'Join Premium ($99/year)? Cancel or pause anytime.',
      '월 9,900원 요금으로 구독하시겠습니까? 언제든지 해지할 수 있습니다.',
      'いつでも解約できます。料金は月980円です。登録しますか？',
      '随时取消。每月费用 ¥30，确定订阅吗？',
      'Remove ads for $4.99/month?',
      'Pause your membership for $5/month?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('takes a downgrade, or a stop beside a start, for a bill', () => {
    for (const message of [
      'Downgrade to Basic ($4.99/month)?',
      'End your trial and start your $9.99/month plan now?',
      'Subscribe for $9.99/month? No refunds on cancellation.',
      'Cancel your current plan and switch to Pro ($9.99/month)?',
      '프리미엄에 가입하시겠습니까? (취소 시 환불 불가) 월 요금 9,900원',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    // A reassurance starts nothing.
    expect(
      accept('Cancel your Premium plan ($9.99/month)? You can upgrade again any time.').category,
    ).toBe('act');
  });

  it('lets a confirm that stops something name its rate', () => {
    for (const message of [
      'Are you sure you want to cancel your Premium plan ($9.99/month)?',
      'Turn off auto-renew? Your plan ($99/year) will end on May 1 and will not be renewed.',
      'Remove this card? Your $9.99/month subscription will need another payment method.',
      // 'Delete the budget category "Groceries" ($600/month)?' is refused now:
      // a category is nothing a bill is for (see the plan switches below).
      'Unsubscribe from Premium ($9.99/month)?',
      'Stop your plan ($9.99/month)?',
      'Pause your plan ($9.99/month)?',
      'Disable auto-renewal ($99/year)?',
      'Deactivate your membership ($5/month)?',
      'End your subscription ($9.99/month)?',
      'Cancelling your $9.99/month plan. Continue?',
      'Cancel your $9.99/month plan? You can resubscribe at any time.',
      '구독을 해지할까요? (월 9,900원)',
      '구독을 해지하시겠습니까? 월 요금 9,900원',
      '解約しますか？料金は月980円です。',
      '取消订阅？年费 ¥49.00',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

// "Expiration date" beside a card is the card's; a passport's or a policy's
// expiry on the same page is not.
describe("classifyAoiBrowserDriveAction - an expiry beside a card that is not the card's", () => {
  const enter = (kind: 'type' | 'select', field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind, selector: '#f', text: '1', value: '1', field });

  it('refuses a card expiry among a card, or named with one', () => {
    const fields: AoiBrowserDriveActionField[] = [
      { label: 'Expiration date', near: 'card' },
      { label: 'Expiry', near: 'card' },
      { label: 'Exp. date', near: 'card' },
      { label: 'MM/YY', near: 'card' },
      { label: 'Card expiry' },
      { label: 'Credit card expiration' },
      // A payment in its fieldset's words counts.
      { label: 'Expiration date Insurance premium payment', near: 'card' },
      // An id that ends in "-id" is no identity document.
      { label: 'Expiration date', id: 'card-exp-id', near: 'card' },
    ];
    for (const field of fields) {
      for (const kind of ['type', 'select'] as const) {
        expect(enter(kind, field).forbidReason, `${kind} ${JSON.stringify(field)}`).toBe(
          'sensitive_field',
        );
      }
    }
  });

  it("does not take a document's, a membership's or a policy's expiry for a card's", () => {
    const fields: AoiBrowserDriveActionField[] = [
      ...[
        'Passport expiry date',
        'Document expiry date',
        "Driver's license expiration",
        'Membership expiry',
        'Coupon expiry date',
        'Insurance policy expiration',
        'ID expiry date',
        'ID card expiry date',
        'Residence card expiry',
        'Membership card expiry',
        'Gift card expiry',
        'Residence permit expiry',
        'Warranty expiration',
        'Domain expiry date',
        'Certificate expiration',
        '여권 유효기간',
        '쿠폰 유효기간',
        'パスポート有効期限',
        'クーポン有効期限',
        '护照有效期',
        '签证有效期',
        '优惠券有效期',
      ].map((label) => ({ label, near: 'card' })),
      { label: 'Expiration date' },
      { label: 'Coupon expiry date' },
    ];
    for (const field of fields) {
      for (const kind of ['type', 'select'] as const) {
        expect(enter(kind, field).category, `${kind} ${JSON.stringify(field)}`).toBe('act');
      }
    }
  });
});

describe('classifyAoiBrowserDriveAction - a name written as it is on an identity document', () => {
  const typeInto = (field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field });
  // What a passenger's fieldset says reaches every box in it.
  const legend = 'Passenger 1 Use the names exactly as written in their passports';

  it('refuses the document, or its number, wherever it is named', () => {
    for (const label of [
      'Passport number',
      'Passport No.',
      'Document number (as shown on your passport)',
      'Enter the number on your passport',
      "Driver's license number",
      'National ID',
      '身份证号码',
      'Name and passport number',
      'Passport name',
      'Surname (as on passport) and passport number',
      '여권번호',
      'パスポート番号',
      `Passport ${legend}`,
      `Passport number ${legend}`,
      `Document number ${legend}`,
      `Document No. ${legend}`,
      'National ID Names must match your national ID',
      'Passport No',
      'Number of your passport',
    ]) {
      expect(typeInto({ label }).forbidReason, label).toBe('sensitive_field');
    }
  });

  it('does not take a name as written on one, or its country, date or status, for it', () => {
    for (const field of [
      { label: 'Given name(s) as per passport' },
      { label: "Full name (as it appears on your driver's license)" },
      { label: `First name ${legend}` },
      { label: `Nationality ${legend}` },
      { label: 'Name (as on passport)' },
      { label: 'Surname from your passport' },
      { label: 'Date of expiry (passport)' },
      { label: 'Expiry date of your passport' },
      { label: 'Issuing country (as shown on your passport)' },
      { label: 'Nationality (as on passport)' },
      { label: 'First name (no nicknames) as on passport' },
      { label: 'Passenger #1 First name as on passport' },
      { label: 'Last name matching your passport' },
      { label: 'Names as they appear on the passport' },
      { label: 'Full name as on passport or national ID' },
      { label: "Name as it appears on your driver's license/passport" },
      { label: 'First name (as on passport)', name: 'passportFirstName' },
      { label: 'Given names as on passport', name: 'booking[passport][given_name]' },
      { label: '姓名（请填写身份证上的姓名）' },
      { label: '真实姓名（与身份证一致）' },
      { label: 'Passport issuing country' },
      { label: 'Passport expiry date' },
      { label: "Driver's license status" },
    ]) {
      expect(typeInto(field).category, JSON.stringify(field)).toBe('act');
    }
  });

  it('reads a prompt() for a name the same way', () => {
    const prompt = (targetText: string) =>
      classifyAoiBrowserDriveAction({
        kind: 'dialog',
        disposition: 'accept',
        promptText: 'x',
        targetText,
      });
    expect(prompt('Enter your name as it appears on your passport').category).toBe('act');
    expect(prompt('Enter your passport number').forbidReason).toBe('sensitive_field');
  });
});

describe('classifyAoiBrowserDriveAction - "Do Not Sell" and "we never sell"', () => {
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('refuses a sale but not a privacy link that refuses one', () => {
    for (const targetText of ['Sell', 'Sell now', 'Sell your car', 'Sell 10 shares']) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
    for (const targetText of [
      'Do Not Sell or Share My Personal Information',
      'Do not sell my info',
      'We never sell your data',
      "We don't sell your data",
      'We don’t sell your data',
      "We won't sell your data",
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });
});

// A confirm that stops one plan and starts another sells the new one, and a
// stop is one only of something a bill is for.
describe('classifyAoiBrowserDriveAction - a plan switch, and a stop that is bought', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a stop beside a plan it starts, and a stop of nothing a bill is for', () => {
    for (const message of [
      'Cancel Basic and get Pro for $9.99/month?',
      'Cancel your Individual plan and get Family for $16.99/month?',
      'Cancel your Basic plan and move to Premium ($14.99/month)?',
      'Cancel your Basic plan and change to Premium ($14.99/month)?',
      'Remove Basic and add Premium for $9.99/month?',
      'Stay on Premium for $4.99/month instead of cancelling?',
      '베이직을 해지하고 프로 요금제(월 9,900원)로 변경하시겠습니까?',
      'ベーシックを解約してプロ（月額980円）に変更しますか？',
      'Remove ads ($4.99/month)?',
      'Turn off ads with Premium ($4.99/month)?',
      'Disable ads ($2.99/month)?',
      'Stop seeing ads: $4.99/month. Continue?',
      // A refusal accepted: a budget category is nothing a bill is for.
      'Delete the budget category "Groceries" ($600/month)?',
      // What a stop stops is in its own sentence, at most four words on.
      // ("Cancel your new Premium Family plan ($9.99/month)?" is let through
      // now: a cancel stops a plan whatever its name.)
      'Remove ads? Your plan stays at $9.99/month.',
      'Remove your new Premium Family plan ($9.99/month)?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
      expect(
        classifyAoiBrowserDriveAction({
          kind: 'dialog',
          disposition: 'dismiss',
          targetText: message,
        }).category,
        message,
      ).toBe('act');
    }
  });

  it('refuses a stop priced for the stopped time', () => {
    for (const message of [
      'Pause your membership ($5/month while paused)?',
      'Pause your membership ($5/month while it is paused)?',
      "Pause your membership ($5/month while it's paused)?",
      'Pause your plan ($2/month during the pause)?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    expect(accept('Pause your plan ($9.99/month)?').category).toBe('act');
  });

  it('knows a plan started in every word for it', () => {
    for (const start of [
      'get Premium',
      'add Premium',
      'go to Premium',
      'go with Premium',
      'go for Premium',
      'move to Premium',
      'move up to Premium',
      'change to Premium',
      'change plan to Premium',
      'stay on Premium',
      'stay with Premium',
      'keep Premium',
      'keep your Premium plan',
      'keep the Premium discount',
      'keep my Premium plan',
      'upgrade to Premium',
      'switch to Premium',
      'switch over to Premium',
    ]) {
      const message = `Cancel your Basic plan and ${start} ($9.99/month)?`;
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    // Creating names a purchase with a rate.
    expect(
      accept('Cancel your Basic plan and create a Premium account ($9.99/month)?').forbidReason,
    ).toBe('financial_commit');
    for (const message of [
      '베이직을 해지하고 프로(월 9,900원)로 전환하시겠습니까?',
      '베이직을 해지하고 프로(월 9,900원)로 업그레이드하시겠습니까?',
      '베이직을 해지하고 프로(월 9,900원)에 가입하시겠습니까?',
      '베이직을 해지하고 프로(월 9,900원)를 구독하시겠습니까?',
      'ベーシックを解約してプロ（月額980円）に切り替えますか？',
      'ベーシックを解約してプロ（月額980円）にアップグレードしますか？',
      'ベーシックを解約してプロ（月額980円）を購読する',
      'ベーシックを解約してプロ（月額980円）に登録する',
      'ベーシックを解約してプロ（月額980円）に登録しますか？',
      'ベーシックを解約してプロ（月額980円）を購読しますか？',
      'ベーシックを解約してプロ（月額980円）に登録しましょう。',
      'ベーシックを解約してプロ（月額980円）に申し込みますか？',
      '取消基本版并升级到专业版（每月¥68）？',
      '取消基本版并切换到专业版（每月¥68）？',
      '取消基本版并更换为专业版（每月¥68）？',
      '取消基本版并改为专业版（每月¥68）？',
      '取消基本版並升級到專業版（每月¥68）？',
      '取消基本版並切換到專業版（每月¥68）？',
      '取消基本版並更換為專業版（每月¥68）？',
      '取消基本版並改為專業版（每月¥68）？',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('lets a stop name its rate beside a start that only reassures', () => {
    for (const message of [
      'Cancel your $9.99/month plan? You can start again anytime.',
      'Cancel your Premium plan ($9.99/month)? You can get it back later.',
      'Cancel your Premium plan ($9.99/month)? You may change plan later.',
      'Cancel your Premium plan ($9.99/month)? Switch to Basic any time.',
      'Cancel your Premium plan ($9.99/month)? You can keep your playlists.',
      '구독을 해지할까요? (월 9,900원) 언제든지 변경할 수 있습니다.',
      '解約しますか？料金は月980円です。いつでも変更できます。',
      '取消订阅？年费 ¥49.00，随时升级。',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('lets a stop of a plan, a card, an order or an item name its price', () => {
    for (const message of [
      'Are you sure you want to cancel your Premium plan ($9.99/month)?',
      'Turn off auto-renew? Your plan ($99/year) will end on May 1 and will not be renewed.',
      'Remove this card? Your $9.99/month subscription will need another payment method.',
      'Unsubscribe from Premium ($9.99/month)?',
      'Stop your plan ($9.99/month)?',
      'Pause your plan ($9.99/month)?',
      'Cancel order? Your total of $49.00 will be refunded.',
      'Delete this transaction of $49.00?',
      'Remove this item? Your new total is $39.00.',
      'Cancel your $9.99/month plan? You can start again anytime.',
      '구독을 해지할까요? (월 9,900원)',
      '解約しますか？料金は月980円です。',
      '取消订阅？年费 ¥49.00',
      // The fourth word on is still what it stops.
      'Cancel your Premium Family plan ($9.99/month)?',
      'Confirm cancellation of your Premium plan ($9.99/month)?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
    for (const thing of [
      'plan',
      'subscription',
      'membership',
      'trial',
      'auto-renew',
      'auto-renewal',
      'auto renewal',
      'renewal',
      'account',
      'card',
      'payment method',
      'order',
      'transaction',
      'booking',
      'reservation',
      'item',
    ]) {
      const message = `Cancel your ${thing} ($9.99/month)?`;
      expect(accept(message).category, message).toBe('act');
    }
    for (const verb of ['Turn off', 'Remove', 'Delete', 'Disable', 'Deactivate', 'Cancelling']) {
      const message = `${verb} your plan ($9.99/month)?`;
      expect(accept(message).category, message).toBe('act');
    }
  });
});

// Money given, tipped, bid or sent with its amount is a commit where a control
// says it, not in a headline or a chat preview that mentions it.
describe('classifyAoiBrowserDriveAction - a verb and its amount where a control says it', () => {
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it("refuses money moved with its amount at the start of a control's words", () => {
    for (const targetText of [
      'Give $25',
      'Tip $5',
      'Bid US $12.50',
      'Invest $100',
      'Contribute $5',
      'Authorize $49.00',
      'Send $50 to Alice',
      'Send Jane Doe $49.00',
      'Support us: Give $25',
      // After every mark that starts a new part, and a symbol before it.
      'Thank you. Give $25',
      'Thank you! Give $25',
      'Ready? Give $25',
      'Support us; Give $25',
      'Donate | Give $25',
      'Donate • Give $25',
      'Donate · Give $25',
      'Jane Doe\nSend $49.00',
      '♥ Give $25',
      '(Give $25)',
      // "US" before an amount is its currency, and friends and family are paid.
      'Send US$25',
      'Send US $25',
      'Send us $5',
      'Send $50 to friends and family',
      "Give $5 to a friend's fundraiser",
    ]) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });

  it('refuses the same in a confirm, wherever the message says it', () => {
    for (const message of [
      'Tip $5.00 to your driver?',
      'Send Jane Doe $49.00?',
      'Bid US $25.00 on this item?',
      'Do you want to send $50.00 to Alice?',
      'Are you sure you want to tip $5?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('does not take a headline, a message, a discount or a referral for one', () => {
    for (const targetText of [
      '3 smart ways to invest $500 this year',
      'Should you give $50 or $100 as a wedding gift?',
      'Do you really have to tip $5 on a pizza delivery?',
      'Can you send me $20 for the cab?',
      'I will bid $300 on the sofa tomorrow',
      'Send a $5 off coupon',
      'Give $5 to a friend',
      'Give $10, get $10',
      'Send me $20',
      'Give $5 off your next order',
      'Give $5 to friends',
      'Send $5 to a friend',
      // Nor a reminder or an offer that is not made yet.
      'Schedule a payment reminder',
      'Schedule payment reminders',
      'Submit offer for approval',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
    for (const targetText of ['Schedule payment', 'Submit offer']) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - more ways a confirm takes money, and rates in words', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses money taken from an account by any name, a qualified total, a rate or money sent', () => {
    for (const message of [
      '£49.00 will be taken from your current account on 1 March.',
      '$49.00 will be taken from your Visa card.',
      '$49.00 will be taken out of your PayPal balance.',
      'Your payment will be taken from your Visa debit card.',
      'Total due today: $49.00. Continue?',
      'Total amount due: $49.00',
      'Total (incl. VAT): $49.00',
      'Total amount due today (incl. VAT): $49.00',
      'Subscribe to Premium ($9.99 a month)?',
      'Premium: $9.99 every week. Continue?',
      'Premium: $99 each year. Continue?',
      '프리미엄(월 9,900원)을 구독하시겠습니까?',
      '프리미엄(매월 9,900원)',
      '专业版（每月¥68）',
      'プロ（毎月980円）',
      'プロ（月々980円）',
      'プロ（980円/月）',
      '$49.00 will be sent to Jane Doe. Continue?',
      '£49.00 will be paid to Acme Ltd from your account. Confirm?',
      '£49.00 will be collected by Direct Debit on 1 March.',
      '$49.00 is being transferred to Jane Doe.',
      '$49.00 gets paid to Jane Doe today.',
      // Money sent charges: a stop does not pass it over.
      'Cancel order? $49.00 will be collected today.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('does not take a message sent, a count, points or a stopped rate for a bill', () => {
    for (const message of [
      'Your message will be sent to Jane. Continue?',
      'Your total is 3 items. Continue?',
      'Points will be added to your account.',
      'Total refund: $49.00',
      'Cancel your plan ($9.99 a month)?',
      '구독을 해지할까요? (매월 9,900원)',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - one-time codes and government numbers by more names', () => {
  const typeInto = (field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field });

  it('refuses a code a message just brought and a government number', () => {
    const fields: AoiBrowserDriveActionField[] = [
      ...[
        "Enter the code we've sent to your phone",
        'Enter the code we have sent to your email',
        'Enter the code that has been sent',
        'The code is sent to your phone',
        'Check your email for a code',
        'Check your phone for the code',
        'Check your inbox for the 6-digit code',
        'Social Insurance Number',
        'Social Insurance No.',
        'SIN',
        'Your SIN',
        'National Insurance number',
        'Aadhaar number',
        'Aadhar',
        'PAN number',
        'PAN card number',
        'PAN No.',
        'Tax File Number',
        'TFN',
        '证件号码',
        '證件號碼',
        '신분증 번호',
        '免許証番号',
      ].map((label) => ({ label })),
      { name: 'sin' },
      { id: 'customer-sin' },
      { name: 'aadhaarNumber' },
      { name: 'nationalInsuranceNumber' },
    ];
    for (const field of fields) {
      expect(typeInto(field).forbidReason, JSON.stringify(field)).toBe('sensitive_field');
    }
  });

  it('does not take a promo, postal or booking code, or a word holding "sin" or "pan", for one', () => {
    for (const label of [
      'Promo code',
      'Postal code',
      'Confirmation number for your booking',
      'Check your email for a discount code',
      'Business name',
      'Basin',
      'Pan size',
      'Company number',
      'Tax file upload',
    ]) {
      expect(typeInto({ label }).category, label).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - an until that accepting answers, and the words a negation carries', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('reads an until clause that names this answer or a commit with its amount', () => {
    for (const message of [
      "Your card won't be charged until you click OK to complete your purchase of $49.00.",
      "Your card won't be charged until you press OK to pay $49.00.",
      "You won't be charged until you click OK to complete your purchase.",
      "You won't be charged until you tap Yes to buy the plan.",
      "You won't be billed until you tap OK but then you pay $49.00",
      "You won't be charged until you confirm and then $49.00 will be charged.",
      "You won't be charged until you place your order of $49.00.",
      "You won't be charged until your total of $49.00 is confirmed.",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const message of [
      "Your card won't be charged until you place your order. Continue?",
      "You won't be charged until you confirm your purchase.",
      "You won't be charged until you click OK.",
      // An amount alone is no commit: the rate it names starts later.
      "You won't be charged until your trial ends on May 1 ($9.99/month after).",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('takes only the words a negated bill is said with between a negation and its bill', () => {
    for (const message of [
      "Don't forget you'll be charged $49.00 today. Continue?",
      "If you don't cancel you'll be charged $9.99 monthly.",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const message of [
      "You won't ever be charged twice.",
      'You will no longer be billed.',
      'You have not yet been charged $49.00',
      "You haven't been charged $49.00.",
      'Your card will not get charged $5 twice.',
      'Your plan will not be automatically renewed ($9.99/month).',
      'You will not currently be charged $5.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

// The executor passes a field's group words (its fieldset legend, its group's
// name) apart from its label; they name what is bought, not what expires.
describe("classifyAoiBrowserDriveAction - an expiry's own words, apart from its group's", () => {
  const enter = (kind: 'type' | 'select', field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind, selector: '#f', text: '1', value: '1', field });

  it('refuses a card expiry under a legend that names what the card buys', () => {
    const fields: AoiBrowserDriveActionField[] = [
      { label: 'Expiration date', group: 'Buy a gift card', near: 'card' },
      { label: 'Expiration date', group: 'Annual parking permit - $120.00', near: 'card' },
      { label: 'Expiry', group: 'Visa application fee', near: 'card' },
      { label: 'Expiration date', group: 'Domain registration', near: 'card' },
      { label: 'Expiration date', group: 'Software license', near: 'card' },
      { label: 'Expiration date', group: 'Student fees', near: 'card' },
      { label: 'Expiration date', group: 'Insurance policy', near: 'card' },
      // A payment in the group's words counts, as in the field's own.
      { label: 'Membership expiry', group: 'Purchase', near: 'card' },
      { label: 'Coupon expiry date', group: 'Total amount', near: 'card' },
      { label: 'Warranty expiration', group: 'Price', near: 'card' },
      // And every other rule reads the group's words as the field's.
      { label: 'Expiration date', group: 'Card details' },
      { label: 'Code', group: 'Verification code' },
    ];
    for (const field of fields) {
      for (const kind of ['type', 'select'] as const) {
        expect(enter(kind, field).forbidReason, `${kind} ${JSON.stringify(field)}`).toBe(
          'sensitive_field',
        );
      }
    }
  });

  it('does not take what else expires, named in the field itself, for the card', () => {
    const fields: AoiBrowserDriveActionField[] = [
      { label: 'Passport expiry date', group: 'Traveller 1', near: 'card' },
      { label: 'Membership expiry', near: 'card' },
      { label: 'Date of expiry (passport)', near: 'card' },
      { label: 'Coupon expiry date', group: 'Traveller 1', near: 'card' },
      { label: 'Expiration date', group: 'Gift card' },
      { label: 'Nickname', group: 'Traveller 1', near: 'card' },
    ];
    for (const field of fields) {
      for (const kind of ['type', 'select'] as const) {
        expect(enter(kind, field).category, `${kind} ${JSON.stringify(field)}`).toBe('act');
      }
    }
  });
});

// Cancel confirms are an ordinary thing to accept: getting, keeping or staying
// starts something only with its price, and a stop stops more kinds of things.
describe('classifyAoiBrowserDriveAction - a start that names its price', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses an offer with its price, whatever the message stops', () => {
    for (const message of [
      'Cancel Basic and get Pro for $9.99/month?',
      'Cancel your Individual plan and get Family for $16.99/month?',
      'Cancel your Basic plan and move to Premium ($14.99/month)?',
      'Cancel your Basic plan and change to Premium ($14.99/month)?',
      'Remove Basic and add Premium for $9.99/month?',
      'Stay on Premium for $4.99/month instead of cancelling?',
      '베이직을 해지하고 프로 요금제(월 9,900원)로 변경하시겠습니까?',
      'ベーシックを解約してプロ（月額980円）に変更しますか？',
      'Remove ads ($4.99/month)?',
      'Turn off ads with Premium ($4.99/month)?',
      'Pause your membership ($5/month while paused)?',
      'Delete the budget category "Groceries" ($600/month)?',
      'Stop your trial and go Pro for $9.99/month?',
      "Don't cancel - get 3 months for $9.99?",
      'Get Pro for $9.99/month?',
      'Keep Premium for $4.99/month instead?',
      'ベーシックを解約してプロ（月額980円）に登録しますか？',
      'Move to Premium($14.99/month)?',
      'Cancel your trial? Change to annual billing for $99/year.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('lets a stop through beside what is kept, got back, set or invoiced', () => {
    for (const message of [
      'Are you sure you want to cancel your Premium plan ($9.99/month)?',
      'Turn off auto-renew? Your plan ($99/year) will end on May 1 and will not be renewed.',
      'Remove this card? Your $9.99/month subscription will need another payment method.',
      'Unsubscribe from Premium ($9.99/month)?',
      'Stop your plan ($9.99/month)?',
      'Pause your plan ($9.99/month)?',
      'Cancel order? Your total of $49.00 will be refunded.',
      'Delete this transaction of $49.00?',
      'Remove this item? Your new total is $39.00.',
      'Cancel your $9.99/month plan? You can start again anytime.',
      '구독을 해지할까요? (월 9,900원)',
      '解約しますか？料金は月980円です。',
      '取消订阅？年费 ¥49.00',
      'Cancel your subscription ($9.99/month)? You will keep access until March 3.',
      "Cancel your subscription ($9.99/month)? You'll get a refund for the unused days.",
      'Cancel your subscription ($9.99/month)? Keep in mind that your playlists stay.',
      'Cancel your subscription ($9.99/month)? Go to Settings to undo this.',
      'Cancel your subscription ($9.99/month)? Your data will stay on our servers for 30 days.',
      "Cancel your plan ($9.99/month)? You'll get a refund of $4.99.",
      "Cancel your plan ($9.99/month)? You'll get $5 back.",
      "Cancel your plan ($9.99/month)? You'll get $5 credit for the unused time.",
      "Cancel your plan ($9.99/month)? You'll get a prorated refund for $4.99.",
      'Cancel your plan ($9.99/month)? Keep your data for 30 days.',
      'Change the price to $49.00?',
      'Change your budget to $600/month?',
      'Change your spending limit to $500/month?',
      'Keep the price at $49.00?',
      'Create an invoice for $49.00?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses a plan, a donation, a tip or a bid changed to a price, and a rate kept', () => {
    for (const message of [
      'Change your plan to $9.99/month?',
      'Change your donation amount to $25/month?',
      'Change your tip to $5.00?',
      'Change your bid to $50.00?',
      'Keep your rate at $9.99/month?',
      'Keep Premium for $5 off ($4.99/month)?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - more things a stop stops, and a cancellation', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a stop of a cart, a product, a donation or a pledge, or a cancellation, name its price', () => {
    for (const message of [
      'Remove from cart? Your new total is $39.00.',
      'Remove this product from your basket? New total: $39.00.',
      'Cancel your donation of $25.00?',
      'Cancel your pledge of $10/month?',
      'Confirm cancellation ($9.99/month)?',
      'Confirm cancelation ($9.99/month)?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
    for (const thing of [
      'cart',
      'basket',
      'bag',
      'product',
      'donation',
      'pledge',
      'purchases',
      'payment',
      'ticket',
      'tickets',
    ]) {
      const message = `Cancel your ${thing} ($9.99/month)?`;
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still bills a cancellation fee, and takes a free cancellation for a sale', () => {
    for (const message of [
      'Cancellation fee: $25.00. Continue?',
      'Cancel your plan? A $10 cancellation fee applies.',
      'Book Premium Plus ($9.99/month)? Free cancellation within 14 days.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - more words a negation carries, and nothing charged', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets through what is not going to be, or not immediately, charged, and nothing charged', () => {
    for (const message of [
      'You are not going to be charged $49.00.',
      'You will not be immediately charged $49.00.',
      "You won't be instantly charged $49.00.",
      'You will not be further charged $5.',
      'You will not still be charged $5.',
      'Nothing is charged now. Continue?',
      'Nothing will be billed today. Continue?',
      'Nothing gets charged today. Continue?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses a charge that only follows another word', () => {
    for (const message of [
      "Don't forget you'll be charged $49.00 today. Continue?",
      'No more than $50 will be charged. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - an amount sent, money sending or spent, an order placed, a total price', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses each', () => {
    for (const message of [
      '$49.00 will be sent to Jane Doe. Continue?',
      '$9.99/month will be paid from your card. Continue?',
      '$49.00 in total will be sent to Jane Doe. Continue?',
      'You are sending $49.00 to Jane Doe.',
      "You'll spend $49.00 from your balance.",
      "You're spending only $49.00 today. Continue?",
      'This places your order for $49.00. Continue?',
      'Total price: $49.00. Continue?',
      'Total payable: $49.00',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const targetText of ['This places your order', 'Sending $49.00 to Jane Doe']) {
      expect(
        classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText }).forbidReason,
        targetText,
      ).toBe('financial_commit');
    }
  });

  it('does not take a message sent beside credit, money paid to you, or more to spend for one', () => {
    for (const message of [
      'Your message will be sent to Jane. You have $5 credit left.',
      'You will be paid $49.00 for this survey.',
      'Spend $5 more to get free shipping. Continue shopping?',
      'Total refund: $49.00',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - an until clause that accepting answers, in the clause reading too', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('reads what the rest of its clause bills', () => {
    for (const message of [
      "You won't be billed until you click OK, which will charge $49.00 to your card.",
      "You won't be charged until you click OK, then $49.00 is charged.",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const message of [
      "Your card won't be charged until you place your order. Continue?",
      "You won't be charged until your trial ends, then $9.99/month.",
      'You will no longer be charged $9.99/month.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a paused price beside its pause', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it("takes a price in the pause's sentence for the pause's, and no other", () => {
    for (const message of [
      'Pause your membership ($5/month while paused)?',
      'Pause your membership? It costs $5/month while paused.',
      'Pause your plan? While paused: $2/month.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const message of [
      'Pause your membership ($9.99/month)? We keep your data while paused.',
      'Pause your plan ($9.99/month)? While paused, you keep your data.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a SIN, an SSN and Aadhaar by name, a code we sent, a date', () => {
  const typeInto = (field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field });

  it('refuses each in a label or a name, and a code a message says was sent', () => {
    const fields: AoiBrowserDriveActionField[] = [
      { name: 'sin' },
      { label: 'SIN' },
      { label: 'SIN number' },
      { label: 'Your SIN' },
      { label: 'SIN (Social Insurance Number)' },
      { name: 'applicant_sin' },
      { name: 'sinNumber' },
      { name: 'sin_number' },
      // Each fact is read alone: a legend after the label is no word after it.
      { label: 'SIN', group: 'Personal information' },
      { name: 'applicant_ssn' },
      { name: 'ssnNumber' },
      { label: 'Aadhaar' },
      { label: 'Aadhaar number' },
      { label: 'Enter your Aadhar' },
      { name: 'aadhaarNumber' },
      { label: 'We sent a code to your phone' },
      { label: "We've sent a 6-digit code to j***@gmail.com" },
      { label: 'We just sent you a verification code' },
    ];
    for (const field of fields) {
      expect(typeInto(field).forbidReason, JSON.stringify(field)).toBe('sensitive_field');
    }
  });

  it('does not take Spanish "sin", a phone linked with Aadhaar or a discount code for one', () => {
    for (const label of [
      'Teléfono (sin espacios)',
      'Código postal (sin guiones)',
      'Precio sin IVA',
      'Mobile number linked with Aadhaar',
      'We sent a discount code to your email',
    ]) {
      expect(typeInto({ label }).category, label).toBe('act');
    }
  });

  it('does not take a Korean date for a rate, or approving a payment method for a payment', () => {
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'dialog',
        disposition: 'accept',
        targetText: '포인트 1,000원이 적립되었습니다. 3월 5일까지 사용하세요.',
      }).category,
    ).toBe('act');
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'dialog',
        disposition: 'accept',
        targetText: '프리미엄(월 9,900원)을 구독하시겠습니까?',
      }).forbidReason,
    ).toBe('financial_commit');
    for (const targetText of ['Approve payment method', 'Approve payment methods']) {
      expect(
        classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText }).category,
        targetText,
      ).toBe('act');
    }
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'click',
        selector: '#x',
        targetText: 'Approve payment',
      }).forbidReason,
    ).toBe('financial_commit');
  });
});

describe('classifyAoiBrowserDriveAction - an em or en dash before what a control says', () => {
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('takes either dash, but not a hyphen, for a mark that starts a part of the words', () => {
    for (const targetText of ['Support us — Give $25', 'Support us – Give $25']) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
    // "Support us - Give $25" is refused as a short control instead.
    expect(click('Support us - Give $25').forbidReason).toBe('financial_commit');
    for (const targetText of [
      '3 smart ways to invest $500 this year',
      'Holiday deals - give $25 gift cards',
      'Last-minute gifts to give $25 and under',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a refund sent back, what a stop stops, a priced start in a reassurance', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a cancel through that sends a refund back or stops a purchase or a payment', () => {
    for (const message of [
      'Cancel order? Your refund of $49.00 will be sent to your card.',
      'Cancel order? A credit of $5.00 will be sent to your account.',
      'Cancel your purchase of $49.00?',
      'Cancel this payment of $49.00?',
      'Cancel your plan ($9.99/month)? You can get Premium again for $9.99/month any time.',
      "You won't be charged to keep your plan ($9.99/month).",
      'Set your budget to $600/month?',
      'Increase your spending limit to $1,000/month?',
      'Update your savings goal to $50/week?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses what the rest of a stop commits, a price after a word in brackets, a bid raised', () => {
    for (const message of [
      'Cancel your Basic plan and get Pro (only $9.99/month)?',
      'Remove this card and pay $49.00 now?',
      'Cancel your purchase and buy the annual plan for $99?',
      "Cancel your order? You'll be charged a $5 fee.",
      'Delete your cart and checkout now?',
      'Raise your bid to $60.00?',
      'Set your plan to $9.99/month?',
      '$49.00 will be sent to Jane Doe. Continue?',
      'Get Pro for $9.99/month?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('does not take a phone linked with your Aadhaar for Aadhaar', () => {
    const typeInto = (label: string) =>
      classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field: { label } });
    for (const label of [
      'Mobile number linked with your Aadhaar',
      'Aadhaar linked mobile number',
    ]) {
      expect(typeInto(label).category, label).toBe('act');
    }
    for (const label of ['Aadhaar number', 'Enter your Aadhaar', 'Aadhaar']) {
      expect(typeInto(label).forbidReason, label).toBe('sensitive_field');
    }
  });
});

describe('classifyAoiBrowserDriveAction - the way back in, a price on more starts, a payment made, codes and ID numbers by more names', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });
  const typeInto = (label: string) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field: { label } });

  it('lets a stop through that says how to start again, in a sentence of its own', () => {
    for (const message of [
      'Cancel your membership ($30/month)? To rejoin, start a new membership from your account.',
      'Delete this transaction of $49.00? This cannot be undone. Start a new one from the menu.',
      'Cancel your auto-renew ($9.99/month)?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('refuses a start that sells, with its price or beside the stop, and an upgrade or account priced', () => {
    for (const message of [
      'Subscribe for $9.99/month? No refunds on cancellation.',
      'End your trial and start your $9.99/month plan now?',
      'Cancel Basic? Upgrade to Pro ($9.99/month) today.',
      'Upgrade to Pro for $9.99?',
      'Start Pro for $9.99?',
      'Delete your free account and create a Pro account for $9.99/month?',
      '프리미엄에 가입하시겠습니까? (취소 시 환불 불가) 월 요금 9,900원',
      'Join Premium. Only $9.99/month. No refunds on cancellation.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    // An invoice created for an amount is not bought.
    expect(accept('Create an invoice for $49.00?').category).toBe('act');
  });

  it('refuses making a payment and checking out for a price, not a payment reminder or plan', () => {
    for (const targetText of ['Make a payment', 'Make this payment', 'Check out for $49.00']) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
    for (const targetText of [
      'Send a payment reminder',
      'Make a payment plan',
      'Check out for free',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });

  it('refuses an order with its amount, not one cancelled', () => {
    for (const message of [
      'Proceed with your order of $49.00?',
      'Continue with this order ($49.00)?',
      'Submit this $49.00 order?',
      'Confirm your order for $49.00?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const message of ['Cancel your order of $49.00?', 'Delete this order ($49.00)?']) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('refuses a code of so many digits or from a message, and government numbers by more names', () => {
    for (const label of [
      'Enter the 6-digit code',
      'Enter the four-digit verification code',
      'Enter the code from the email we sent',
      'Enter the code from your text message',
      'Government ID number',
      'State ID number',
      'Identity number',
      'Personal identity code',
      'NRIC',
      'Resident registration number',
      'DL number',
      'DL #',
    ]) {
      expect(typeInto(label).forbidReason, label).toBe('sensitive_field');
    }
    for (const label of [
      'Enter the promo code from the email',
      'Enter the 8-digit gift card code',
      'ID number',
      'Member ID',
    ]) {
      expect(typeInto(label).category, label).toBe('act');
    }
  });
});

// Round 15: a stop that swallowed the commit after it, cancels of named
// plans, money sent back, a priced pause, bracketed amounts, "nothing …
// except", verb and amount on a control, more plan verbs and rate words, and
// fields by more names.
describe('classifyAoiBrowserDriveAction - a stop does not swallow the commit after it', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a commit joined to a stop by "and", "then" or a comma', () => {
    for (const message of [
      'This promo code has expired. Remove it and place order?',
      'This coupon has expired. Remove coupon and complete purchase?',
      'Your promo code is not valid for these items. Remove it and complete purchase?',
      'Your saved card has expired. Remove it and make payment?',
      'Remove coupon and complete purchase of $49.00?',
      'Remove discount and submit order?',
      'Remove warranty and complete payment?',
      'Payment failed. Remove and retry payment?',
      'Cancel changes and confirm order?',
      'Disable 1-Click and complete purchase?',
      'Remove it and confirm payment?',
      'Cancel and buy new plan ($99/year)?',
      'Remove the coupon and complete your purchase?',
      'Remove gift wrap and complete order?',
      'Remove this card, then pay $49.00 now?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a stop of a purchase, a payment, a cart item or an order name its amount', () => {
    for (const message of [
      'Cancel your purchase of $49.00?',
      'Cancel this payment of $49.00?',
      'Remove from cart? Your new total is $39.00.',
      'Cancel your order of $49.00?',
      'Remove your pay-per-view purchase ($4.99)?',
      'Remove your $1,000/year plan?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a cancel stops a plan by any name', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a cancel, an unsubscribe or a stop of renewing name its rate', () => {
    for (const message of [
      'Cancel Premium ($9.99/month)?',
      'Are you sure you want to cancel? Your Premium plan ($9.99/month) stays active until March 3.',
      'Cancel your Xbox Game Pass Ultimate membership ($16.99/month)?',
      'Cancel Spotify Premium ($10.99/month)?',
      'Stop renewing Premium ($9.99/month)?',
      'Cancel your YouTube Premium Family plan ($22.99/month)?',
      'Cancel your Netflix and Hulu subscriptions ($15.49/month)?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses what other stops leave without a billed thing, and a stop beside a start', () => {
    for (const message of [
      'Remove ads ($4.99/month)?',
      'Turn off ads with Premium ($4.99/month)?',
      'Cancel Basic and get Pro for $9.99/month?',
      'Cancel your trial and start Pro now ($9.99/month)?',
      'Cancellation fee: $25.00. Continue?',
      'Cancel your plan? A $10 cancellation fee applies.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - money sent back, and a period after an amount', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a refund or money sent back through, and an email sent after an amount', () => {
    for (const message of [
      'Cancel this order? $49.00 will be sent back to your card.',
      'Cancel this order? You paid $49.00. A confirmation email will be sent.',
      'Return this item? A refund for the full $49.00 will be sent to your card.',
      "Cancel your order? We're sending your $49.00 refund to your card.",
      'Return this item? Your refund amount of $49.00 will be sent to your card.',
      'Cancel? $49.00 will be paid back within 5 days.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses money sent, paid or sending', () => {
    for (const message of [
      '$49.00 will be sent to Jane Doe. Continue?',
      '$9.99/month will be paid from your card. Continue?',
      'You are sending $49.00 to Jane Doe.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    // A period ends the amount, so a referral split by one is a gift again.
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'click',
        selector: '#x',
        targetText: 'Give $10. Get $10.',
      }).forbidReason,
    ).toBe('financial_commit');
  });
});

describe('classifyAoiBrowserDriveAction - a pause priced, and a bracketed amount', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('takes a pause for bought only beside its rate or with a fee word', () => {
    expect(
      accept('Pause your membership for 3 months? Your $30/month rate is locked while paused.')
        .category,
    ).toBe('act');
    for (const message of [
      'Pause your membership ($5/month while paused)?',
      'Pause your membership? It costs $5/month while paused.',
      'Pause your plan? While paused: $2/month.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('takes an amount in brackets for a price only with its rate or a price word', () => {
    for (const message of [
      'Move 3 transactions ($149.00) to Groceries?',
      'Decline the offer and keep your price ($49.00)?',
      'Move this booking ($35.00) to Friday 3 PM?',
      'Change the amount ($49.00) for this expense?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
    for (const message of [
      'Cancel your Basic plan and move to Premium ($14.99/month)?',
      'Cancel your Basic plan and change to Premium ($14.99/month)?',
      'Cancel your Basic plan and get Pro (only $9.99/month)?',
      'Remove the free plan ($0) and keep Premium ($9.99/month)?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - nothing charged except, and an amount before its until', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses what is charged besides nothing, and an amount withheld until OK', () => {
    for (const message of [
      'Nothing is charged today except the $49.00 setup fee. Continue?',
      'Nothing will be billed now other than a $49.00 activation fee. Continue?',
      'Nothing is charged now, only $49.00 at delivery. Continue?',
      'Nothing is charged today apart from the $49.00 setup fee. Continue?',
      'Nothing is charged today besides the $49.00 setup fee. Continue?',
      'Nothing is charged until you click OK, which places your $49.00 order.',
      "You won't be charged anything except the $49.00 setup fee. Continue?",
      "You won't be charged $49.00 until you click OK.",
      "Your card won't be charged the $49.00 until you click OK.",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets nothing charged through', () => {
    for (const message of [
      'Nothing is charged now. Continue?',
      'Nothing will be billed today. Continue?',
      "Nothing is charged now. You won't be charged until you place your order.",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a verb and its amount on a short control or at a piece start', () => {
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('refuses each', () => {
    for (const targetText of [
      'Support us - Give $25',
      '👍🏽 Tip $5',
      'Add tip $5',
      'Leave tip $5',
      'Quick bid US $12.50',
      'Auto-invest $50',
      '👍🏽 Tip $5 to support the creator today',
    ]) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });

  it('still lets a longer headline or message through', () => {
    for (const targetText of [
      '3 smart ways to invest $500 this year',
      'Should you give $50 or $100 as a wedding gift?',
      'Can you send me $20 for the cab?',
      // Six words, and a hyphen is no mark: read as a headline.
      'Support our school fundraiser - Give $25',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - more ways to buy a plan, and rate words', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a plan tried, continued, rejoined, extended or unlocked with its price', () => {
    for (const message of [
      'Cancel your Basic plan and try Pro for $9.99/month?',
      'End your trial and continue with Premium ($9.99/month)?',
      'Cancel your membership and rejoin for $30/month?',
      'Cancel your Basic plan and move to Premium at $14.99/month?',
      'Cancel your Basic plan and get Pro at just $9.99/month?',
      'End your trial now? Premium ($9.99/month) starts today.',
      '베이직 요금제를 해지하고 프로 요금제(월 9,900원)를 시작하시겠습니까?',
      '현재 요금제를 취소하고 프로 요금제(월 9,900원)를 신청하시겠습니까?',
      '베이직을 해지하고 프로(월 9,900원)를 이용하시겠습니까?',
      'ベーシックプランを解約して、プロプラン（月額980円）を契約しますか？',
      'ベーシックを解約してプロ（月額980円）を開始しますか？',
      '取消基础版并订阅专业版（每月¥68）？',
      'Extend your membership for $49.00?',
      'Unlock all levels for $4.99?',
      'Cancel your monthly plan and choose the annual plan ($99/year)?',
      'Cancel your subscription and resubscribe at $7.99/month?',
      'Cancel your plan and reactivate it for $9.99/month?',
      'Pause your membership and pick a cheaper plan ($5/month)?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('does not take a start date, a cancellation applied for, a plan held or shopping on for a start', () => {
    for (const message of [
      '구독 해지를 신청하시겠습니까? (월 9,900원)',
      '구독을 해지할까요? (구독 시작일: 3월 5일, 월 9,900원)',
      '現在ご契約中のプラン（月額980円）を解約しますか？',
      '現在加入中のプラン（月額980円）を解約しますか？',
      '解約しますか？ご利用開始日：3月1日（月額980円）',
      '取消订阅？年费 ¥49.00',
      'Remove this item? Continue shopping for $5 deals.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('refuses a rate in words, an order placed with its amount, money debited or taken, and keeps dates out', () => {
    for (const message of [
      'Start your free trial? After 3 days, $4.99/week.',
      'Subscribe to Pro? $9.99 weekly.',
      'Join Pro? $29.99 quarterly.',
      'Continue with Basic Digital at $4/wk?',
      '开通年度会员（¥198/年）？',
      '年間プラン（9,800円/年）に登録しますか？',
      '开通年度会员，每年¥198？',
      '프리미엄을 매년 99,000원에 구독하시겠습니까?',
      'プレミアムを毎年9,800円で購読しますか？',
      '프리미엄 연간 이용권(연 99,000원)을 구독하시겠습니까?',
      'This places your $49.00 order. Continue?',
      'Placing your $49.00 order. Continue?',
      'We will debit $49.00 from your account. Continue?',
      '£49.00 will be taken on 1 March. Continue?',
      '$49.00 will be withdrawn on March 3. Continue?',
      '프리미엄(월 9,900원)을 구독하시겠습니까?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const message of [
      '포인트 1,000원이 적립되었습니다. 3월 5일까지 사용하세요.',
      '2026년 3월 5일에 해지됩니다. 해지할까요? (월 9,900원)',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - Aadhaar as written, codes that redeem, payments made recurring, more names', () => {
  const typeInto = (field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('does not take a name, a birth date or a gender as on Aadhaar, or a gift card code, for one', () => {
    const fields: AoiBrowserDriveActionField[] = [
      { label: 'Full name (as per Aadhaar)' },
      { label: 'Date of birth (as per Aadhaar)' },
      { label: 'Gender (as per Aadhaar)' },
      { label: 'Name on Aadhaar' },
      { label: 'Full name', group: 'Details as per Aadhaar' },
      { label: "Father's name (as per Aadhaar)" },
      { label: 'Mobile number linked with your Aadhaar' },
      { label: 'Gift card', placeholder: 'Enter the 16-digit code on the back of your card' },
      { label: 'Pan size' },
      { label: 'Frying pan' },
      { name: 'isSingle' },
      { id: 'BASIN' },
    ];
    for (const field of fields) {
      expect(typeInto(field).category, JSON.stringify(field)).toBe('act');
    }
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'select',
        selector: '#s',
        value: 'F',
        field: { label: 'Gender (as per Aadhaar)' },
      }).category,
    ).toBe('act');
  });

  it('refuses Aadhaar, a code of digits, a bare PAN, a code received, an NI number and camel names', () => {
    const fields: AoiBrowserDriveActionField[] = [
      { label: 'Aadhaar number' },
      { label: 'Aadhaar no' },
      { label: 'Aadhaar #' },
      { label: 'Aadhaar UID' },
      { label: 'Aadhaar' },
      { label: 'Enter your Aadhar' },
      { name: 'aadhaarNumber' },
      { label: 'Enter the 6-digit code' },
      { label: 'PAN' },
      { label: 'PAN:' },
      { label: 'Tax ID', placeholder: 'ABCDE1234F' },
      { label: 'Enter the code you received' },
      { label: 'NI number' },
      { name: 'employeeSsn' },
      { id: 'txtSIN' },
      { id: 'txtSsn' },
    ];
    for (const field of fields) {
      expect(typeInto(field).forbidReason, JSON.stringify(field)).toBe('sensitive_field');
    }
    expect(typeInto({ label: 'Enter the promo code you received' }).category).toBe('act');
  });

  it('does not take a payment made recurring or an arrangement for a payment', () => {
    for (const targetText of ['Make this payment recurring', 'Make a payment arrangement']) {
      expect(click(targetText).category, targetText).toBe('act');
    }
    expect(click('Make a payment').forbidReason).toBe('financial_commit');
  });
});

// Round 15 tuning, from its report's own lists.
describe('classifyAoiBrowserDriveAction - a passive cancel, an address as written, tips, PAN, codes, a new order, a cadence, stored money', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });
  const typeInto = (field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field });

  it('lets a plan said to be cancelled name its rate, but not a charge beside it', () => {
    for (const message of [
      'Your Premium plan ($9.99/month) will be cancelled. Continue?',
      'Your Premium plan ($9.99/month) will be canceled. Continue?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
    expect(
      accept("Your trial will be cancelled and you'll be charged $9.99/month. Continue?")
        .forbidReason,
    ).toBe('financial_commit');
  });

  it('takes an address as written on Aadhaar for no Aadhaar, and still refuses Aadhaar', () => {
    for (const field of [
      { label: 'Address (as per Aadhaar)' },
      { name: 'address_line1', placeholder: 'As per Aadhaar' },
    ]) {
      expect(typeInto(field).category, JSON.stringify(field)).toBe('act');
    }
    for (const label of ['Aadhaar number', 'Aadhaar']) {
      expect(typeInto({ label }).forbidReason, label).toBe('sensitive_field');
    }
  });

  it('refuses a tip, a chip-in and a tip or donation added with its amount, on a control or in a confirm', () => {
    for (const targetText of [
      'Tip: $5',
      'Tip Jane $5',
      'Tip the driver $5',
      'Add a $5 tip',
      'Leave a $5 tip',
      'Add a $5 donation',
      'Chip in $5',
    ]) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
    for (const message of [
      'Would you like to tip the driver $5?',
      'Add a $5 tip?',
      'Chip in $5?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const targetText of [
      'How to add a $5 tip on DoorDash and why it matters',
      'Tip: save 20%',
      'Add a $5 gift card',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });

  it('refuses a PAN in capitals or a PAN card, not a pan for cooking', () => {
    for (const field of [
      { label: 'Enter your PAN' },
      { label: 'PAN Card' },
      { label: 'Your PAN' },
      { name: 'pan_card' },
    ]) {
      expect(typeInto(field).forbidReason, JSON.stringify(field)).toBe('sensitive_field');
    }
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'dialog',
        disposition: 'accept',
        promptText: 'x',
        targetText: 'Enter your PAN',
      }).forbidReason,
    ).toBe('sensitive_field');
    for (const label of ['Grease the pan', 'Pan size', 'Frying pan']) {
      expect(typeInto({ label }).category, label).toBe('act');
    }
  });

  it('refuses a code a message brought, and a SIN before a word that says what the field is', () => {
    for (const label of [
      'We emailed you a code',
      "We've texted you a code",
      'We sent you a 6-digit code',
      'Code sent via SMS',
      'Code sent to your email',
      'SIN - required',
      'Enter SIN here',
      'SIN (optional)',
    ]) {
      expect(typeInto({ label }).forbidReason, label).toBe('sensitive_field');
    }
    for (const label of [
      'We emailed you a discount code',
      'Promo code sent to your email',
      'Teléfono (sin espacios)',
      'Precio sin IVA',
    ]) {
      expect(typeInto({ label }).category, label).toBe('act');
    }
  });

  it('refuses a new order placed, a cadence with its price, and stored money spent', () => {
    for (const message of [
      'Cancel your order and place a new order for $49.00?',
      'Start Premium: $9.99 every 2 weeks?',
      'Use $49.00 from your gift card balance?',
      'Apply $49.00 store credit to this order?',
      'Your Visa ending 4242 will be used for this $49.00 order.',
      'Finish your order of 2 items ($49.00)?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    expect(click('Place a new order').forbidReason).toBe('financial_commit');
    for (const message of ['Accept the offer of $49.00 for your item?', 'Use 500 points?']) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - an order finished later, and one ordered again', () => {
  it('lets an order be left for later, and refuses one ordered again for its price', () => {
    const click = (targetText: string) =>
      classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });
    expect(click('Finish your order later').category).toBe('act');
    expect(click('Finish your order').forbidReason).toBe('financial_commit');
    expect(click('Reorder for $49.00').forbidReason).toBe('financial_commit');
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'dialog',
        disposition: 'accept',
        targetText: 'Your order was cancelled. Reorder for $49.00?',
      }).forbidReason,
    ).toBe('financial_commit');
    // Reordering a list is no order.
    expect(click('Reorder list').category).toBe('act');
  });
});

// Round 16: a confirm that names its own Cancel button, commit phrases with an
// amount or a kind between the verb and the noun, a credit card, a code's
// digits, one-time code labels, a negated clause that ends at "only",
// currencies, short finance headlines, start words in cancels and offers, and
// cancels that name what they cancel.
describe('classifyAoiBrowserDriveAction - a confirm that names its own Cancel button', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a confirm that pays, whatever it says its Cancel button does', () => {
    for (const message of [
      'Total: $49.00. Press OK to continue or Cancel to go back.',
      'Proceed with your order of $49.00? Click Cancel to go back.',
      'Your total today is $49.00. Press Cancel to go back.',
      'Monthly donation of $25.00 to Red Cross. Click OK to confirm or Cancel to change the amount.',
      'Premium plan: $9.99/month. Click OK to confirm or Cancel to go back.',
      'Total: $49.00. OK to proceed? (Choose Cancel to keep shopping.)',
      'Continue with this order ($49.00)? Cancel returns you to the cart.',
      'Total: $49.00. If you cancel, your cart is saved. Continue?',
      'Submit this $49.00 order? Press Cancel to keep shopping.',
      'Total: $49.00. Proceed?',
      // The same buttons in more words.
      'Your total is $49.00. Click OK to confirm or Cancel to go back.',
      'Confirm this transaction of $49.00? Choose Cancel to edit it.',
      'Donation of $25.00 to Red Cross. OK to confirm, Cancel to go back.',
      'Order ($49.00) will be submitted. Press Cancel to abort.',
      'Total due today: $49.00. Click Cancel if you do not want to continue.',
      'Total: $49.00. Hit "Cancel" to go back.',
      'Total: $49.00. Tap on the Cancel button to edit your order.',
      'Total: $49.00. Cancel will take you back to the cart.',
      'If you choose to cancel, your cart is saved. Total: $49.00. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a cancel through that names what it cancels', () => {
    for (const message of [
      'Cancel Premium ($9.99/month)?',
      'Are you sure you want to cancel? Your Premium plan ($9.99/month) stays active until March 3.',
      'Your Premium plan ($9.99/month) will be cancelled. Continue?',
      'Cancel your order of $49.00? Press OK to cancel the order or Cancel to keep it.',
      'If you cancel your order of $49.00, you will get a full refund. Continue?',
      'Total: $49.00. Cancel takes effect immediately.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
    // A Cancel button that cancels leaves OK to keep the plan at its price.
    expect(accept('Press Cancel to cancel your subscription ($9.99/month).').forbidReason).toBe(
      'financial_commit',
    );
  });

  it('refuses a stop beside a start told as what accepting does, in any sentence', () => {
    for (const message of [
      'Cancel Basic? You will be upgraded to Pro automatically. New price: $14.99/month.',
      'Your Basic plan will be cancelled. Premium will start today. Continue? ($14.99/month)',
      "Cancel your Basic plan? You'll switch to Pro. Pro is $14.99/month.",
      "Cancel Basic? We'll upgrade you to Pro. New price: $14.99/month.",
      "Cancel Basic? We'll move you back to Premium ($9.99/month).",
      'Cancel Basic? Your plan will be renewed as Pro at $14.99/month.',
      'Cancel your trial? You will be enrolled in Premium ($9.99/month).',
      'Cancel your trial? You will be subscribed to Premium ($9.99/month).',
      "Cancel Basic? You're being upgraded to Pro ($14.99/month).",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('does not take a reassurance, a free plan, a denial or what is not the user moved for a start', () => {
    for (const message of [
      'Cancel your membership? You can restart anytime for $9.99/month.',
      'Your Premium plan will be cancelled. You can restart anytime for $9.99/month. Continue?',
      "Cancel Premium ($9.99/month)? You'll be switched to the Free plan.",
      "Cancel Premium ($9.99/month)? We'll switch you to Free.",
      'Cancel Pro ($14.99/month)? You will be moved to the free plan at the end of your billing period.',
      "Unsubscribe from Premium ($9.99/month)? You'll still be subscribed to our newsletter.",
      'Turn off auto-renew? Your plan will be renewed at $9.99/month unless you turn it off.',
      'Turn off auto-renew? Your subscription ($9.99/month) renewed on March 3.',
      'Cancel Premium? You will be subscribed until March 3 ($9.99/month).',
      "Cancel Premium ($9.99/month)? You won't be moved to Pro.",
      'Cancel Premium ($9.99/month)? You could be upgraded at any time.',
      "Cancel Premium ($9.99/month)? We'll switch you back whenever you like.",
      'Cancel Premium ($9.99/month)? Your photos will be moved to Basic storage.',
      "Cancel your subscription ($9.99/month)? We'll move your files to the archive.",
      'Cancel Basic ($4.99/month)? Your Pro trial will start processing soon.',
      'Cancel your membership ($30/month)? To rejoin, start a new membership from your account.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - commit phrases with an amount or a kind between the verb and the noun', () => {
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a payment, a donation, a tip or an order with its amount or kind', () => {
    for (const targetText of [
      'Submit $49.00 payment',
      'Make a $49.00 payment',
      'Confirm $49.00 payment',
      'Schedule $49.00 payment',
      'Make a one-time payment',
      'Make a $25 donation',
      'Complete your $25 donation',
      'Confirm $49.00 order',
      'Submit $5 tip',
      'Place an order',
      // More amounts and kinds.
      'Make an extra payment',
      'Make your monthly payment',
      'Make a $9.99/month payment',
      'Make a $49.00 one-time payment',
      'Approve a $49.00 payment',
      'Release final payment',
      'Submit $25 monthly donation',
      'Confirm $25 pledge',
      'Make a gift of $25',
      'Complete $49.00 order',
    ]) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
    for (const message of [
      'Confirm your $49.00 payment to Acme Utilities?',
      'Make a $25.00 donation to Red Cross?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a reminder, a plan, a method, an overview, a gift note or a later order through', () => {
    for (const targetText of [
      'Make a payment reminder',
      'Make a payment plan',
      'Make this payment recurring',
      'Schedule a payment reminder',
      'Approve payment method',
      'Finish order later',
      'Schedule payments overview',
      'Schedule a $49.00 payment reminder',
      'Send a gift message',
      'Confirm gift message',
      'Complete your gift registry',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
    // What is cancelled with its amount is still only stopped.
    for (const message of ['Cancel your $49.00 order?', 'Cancel your $25 donation?']) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a credit card is no credit given back', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses money paid, sent or collected with a credit card', () => {
    for (const message of [
      'Using your Visa credit card ending 4242, $49.00 will be paid to Acme Inc. Continue?',
      'With your credit card, $49.00 will be sent to Jane Doe now. Continue?',
      'Using your credit card ending 4242: $49.00 will be collected now.',
      'Your credit card will be used and $49.00 will be sent to Jane Doe. Continue?',
      'Credit card payment: $49.00 will be taken today. Continue?',
      'From your credit line, $500.00 will be transferred to checking. OK?',
      // A credit that names another amount, or none.
      'Your store credit is $0.00, so $49.00 will be paid by card. Continue?',
      'A refund of $10 will be sent and $49.00 will be paid to Jane Doe. Continue?',
      'Refunds are not available; $49.00 will be paid now. Continue?',
      'No refunds: $49.00 will be sent to Acme. Continue?',
      'Your refund was processed and $49.00 will be paid to Acme now. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'click',
        selector: '#x',
        targetText: 'Send $49.00 credit card payment to Chase',
      }).forbidReason,
    ).toBe('financial_commit');
  });

  it('still lets a refund or a credit through that names its own amount', () => {
    for (const message of [
      'Return this item? A refund for the full $49.00 will be sent to your card.',
      "Cancel your order? We're sending your $49.00 refund to your card.",
      'Cancel this order? $49.00 will be sent back to your card.',
      'A $49.00 store credit will be sent to your account. Continue?',
      'A refund for the full US$49.00 will be sent to your card.',
      'Refund: $49.00 will be sent to your card.',
      'A refund in the amount of $49.00 will be sent to your card.',
      'Your refund ($49.00) will be sent to your card.',
      'Your refund will be $49.00 and will be sent to your card.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a one-time code by its digits, whatever its group says', () => {
  const typeInto = (field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field });

  it('refuses a code of eight digits or fewer under a gift card, a booking or a sign-in', () => {
    const fields: AoiBrowserDriveActionField[] = [
      { label: 'Enter the 6-digit code', group: 'Check your gift card balance' },
      { label: 'Enter the 6-digit code', group: 'Manage your booking' },
      { label: 'Enter the 6-digit code', group: 'Sign in' },
      { label: '6-digit access code', group: 'Your tickets' },
    ];
    for (const field of fields) {
      expect(typeInto(field).forbidReason, JSON.stringify(field)).toBe('sensitive_field');
    }
    // A longer code is one too where nothing says what it redeems.
    expect(typeInto({ label: 'Enter the 12-digit code' }).forbidReason).toBe('sensitive_field');
  });

  it('still lets a long code through that the field says redeems a gift card', () => {
    const fields: AoiBrowserDriveActionField[] = [
      { label: 'Gift card', placeholder: 'Enter the 16-digit code on the back of your card' },
      { label: 'Enter the 16-digit code on the back of your card', group: 'Gift card' },
      { label: 'Enter the 8-digit gift card code' },
    ];
    for (const field of fields) {
      expect(typeInto(field).category, JSON.stringify(field)).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - more one-time code labels', () => {
  const typeInto = (field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field });

  it('refuses a code texted, in an email or from an authenticator', () => {
    for (const label of [
      'We texted a confirmation code to your phone',
      'Enter the code from Google Authenticator',
      'Enter the code in the email we sent you',
      'Enter the code from your authenticator app',
      'Enter the code in your text message',
      'Enter the code shown in Microsoft Authenticator',
    ]) {
      expect(typeInto({ label }).forbidReason, label).toBe('sensitive_field');
    }
  });

  it("still lets a booking's confirmation code or number through", () => {
    const fields: AoiBrowserDriveActionField[] = [
      { label: 'Confirmation code' },
      { label: 'Confirmation code', group: 'Find your booking' },
      { label: 'Enter your confirmation number' },
      { label: 'Enter the promo code in the email' },
    ];
    for (const field of fields) {
      expect(typeInto(field).category, JSON.stringify(field)).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a negated clause that ends at "only"', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses what is still charged after only, just or plus', () => {
    for (const message of [
      "You won't be charged now, only $49.00 at delivery. Continue?",
      'Nothing is charged now, only $49.00 at delivery.',
      "You won't be billed today, just the $49.00 deposit. Continue?",
      "You won't be charged today, plus $5.00 shipping at delivery. Continue?",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets nothing charged through', () => {
    for (const message of [
      "You won't be charged. Continue?",
      "You won't be charged until your trial ends on March 3.",
      "You won't be charged until you place your order. Continue?",
      'You will no longer be charged $9.99/month, only for the days you used.',
      "You won't be charged just yet. Continue?",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - more currencies', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('refuses an amount in rupees, Canadian, Australian and other dollars and crowns', () => {
    for (const message of [
      'Total: INR 499.00. Proceed?',
      'Send CAD 500.00 to Jane Doe?',
      'Total: AUD 49.00. Continue?',
      'Total: Rs. 499. Proceed?',
      'Total: Rs.499. Proceed?',
      'Total: NZD 49.00. Continue?',
      'Total: CHF 49.00. Continue?',
      'Send SGD 50 to Jane?',
      'Total: MXN 499. Continue?',
      'Total: BRL 49,90. Continue?',
      'Total: ZAR 499. Continue?',
      'Total: SEK 499. Continue?',
      'Total: NOK 499. Continue?',
      'Total: DKK 499. Continue?',
      'Total: PLN 49. Continue?',
      'Total: AED 49. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const targetText of ['Pay Rs. 499', 'Give Rs. 500', 'Tip AUD 5']) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });

  it('does not take the letters inside a word, or Rs before no number, for a currency', () => {
    for (const message of [
      'Restore defaults?',
      'Show prices in Rs?',
      'Arcade 49 credits. Continue?',
      'Users 5. Continue?',
      'Fraud 5 reported. Continue?',
      'Nokia 3310. Continue?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
    expect(click('Send CAD files').category).toBe('act');
  });
});

describe('classifyAoiBrowserDriveAction - short finance headlines', () => {
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('lets a short piece through that asks how, where, why or what to move money', () => {
    for (const targetText of [
      'How to invest $1,000',
      'How to send $1,000 abroad',
      'How much to tip $50?',
      'Why you should tip $5',
      'What to give $50',
      'Where to invest $10K now',
      'Should you invest $500?',
      'When to tip $5?',
      'How best to invest $500',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });

  it('still refuses a short control that moves money', () => {
    for (const targetText of [
      'Tip $5',
      'Add tip $5',
      'Give $50 today',
      'Support us - Give $25',
      'Invest $1,000',
      'Send $1,000',
      'How to: Give $25',
    ]) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - start words in cancels and in seller or booking confirms', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('does not take a contract named, a start not made, a reassurance, a past start or a choice of an item for a start', () => {
    for (const message of [
      'プレミアムを解約しますか？月額980円の契約は3月3日に終了します。',
      '멤버십을 해지하시겠습니까? 월 9,900원 멤버십은 3월 3일 이후 새로 시작하지 않습니다.',
      '取消订阅？（每月 ¥30）取消后可随时重新订阅。',
      'Cancel your membership? Restart anytime for $9.99/month.',
      'Cancel your membership? Rejoin any time for $9.99/month.',
      'Cancel your Premium membership? Your membership ($9.99/month) started on March 3.',
      "Take the buyer's offer for $45.00?",
      'Select this room for $129/night?',
      'Choose this flight for $249.00?',
      // The same, in more words and scripts.
      'プレミアムを解約しますか？（月額980円）次回の契約更新は行われません。',
      '定期便を解約しますか？（月額980円）お届けは今月で終了し、新しい契約は開始されません。',
      '멤버십을 해지하시겠습니까? 월 9,900원 멤버십은 3월 3일까지 이용 가능하며, 이후 새로 시작하지 않습니다.',
      'Cancel your membership? Restart for $9.99/month anytime.',
      'Cancel your plan? Rejoin later for $9.99/month.',
      'Cancel your plan? Upgrade later for $9.99/month.',
      'Cancel your trial? Start anytime for $9.99/month.',
      'Pick seat 12A for $25.00?',
      'Select all invoices for $1,250.00 and mark them paid?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses a priced start, a start under way, a contract made and a plan chosen with its rate', () => {
    for (const message of [
      'Try again for $0.99?',
      'Restart your trial for $0.00?',
      'Premium ($9.99/month) starts today',
      'Premium starts today at $9.99/month',
      '이용을 시작하시겠습니까? 월 9,900원',
      '契約しますか？月額980円',
      '开通会员？每月¥30',
      '연 99,000원 가입',
      'Select Premium for $9.99/month?',
      'Cancel your Premium membership? Your membership ($9.99/month) started today.',
      'Cancel your subscription? Take 3 months for $9.99?',
      'Cancel Basic and choose Pro for $9.99/month?',
      'Upgrade to Pro for $9.99/month and cancel later?',
      'Subscribe today and cancel later ($9.99/month)?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - cancels that name what they cancel', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a cancel through that names a payment, an order, a subscription or a transfer', () => {
    for (const message of [
      '결제를 취소하시겠습니까?',
      '자동결제를 해지하시겠습니까?',
      '구독을 해지하시겠습니까? 다음 결제일부터 요금이 청구되지 않습니다.',
      '注文をキャンセルしますか？お支払い済みの4,900円は返金されます。',
      'Cancel this scheduled transfer of $500.00?',
      // The same, in more words and scripts.
      '구매를 취소하시겠습니까?',
      '정기결제를 해지하시겠습니까? (월 9,900원)',
      '송금을 취소하시겠습니까? 49,000원',
      '決済をキャンセルしますか？',
      'お支払いを取り消しますか？',
      '送金を取り消しますか？49,000円',
      '确定要取消支付吗？',
      '关闭自动续费？每月¥30',
      '自動更新を停止しますか？次回の決済日以降、請求されません。',
      'Cancel this transfer?',
      'Cancel this wire transfer?',
      'Cancel this withdrawal?',
      'Cancel your bid of $49.00?',
      'Cancel your trade?',
      'Cancel the deposit of $200.00?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses a payment, an order or a transfer that is made', () => {
    for (const message of [
      '결제하시겠습니까?',
      '결제를 진행하시겠습니까?',
      '注文を確定しますか？',
      'Transfer $500.00 to Jane?',
      'Cancel this transfer and send $500.00 now?',
      '결제를 취소하고 다시 결제하시겠습니까?',
      '이체를 취소하고 50,000원을 송금하시겠습니까?',
      '取消支付并重新支付¥49.00？',
      'Cancel this wire transfer and send $500.00 now?',
      'Cancel your withdrawal of $200.00 and withdraw $300.00 instead?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

// Round 16 tuning: a stop counts where the message asks it, totals in more
// words, a clause still charged after a semicolon or a dash, a tip or a payment
// kind, token codes, starts told without be or will, tips and gifts only with
// an amount, currency codes before a model or a year, the Cancel button's
// clause, a switch onto a way to pay, more headlines.
describe('classifyAoiBrowserDriveAction - a stop counts where the message asks it', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a checkout whose stop is only reported or named', () => {
    for (const message of [
      'Cancellation is free. Total: $129.00. Continue?',
      'One item was cancelled because it is out of stock. Your total is now $49.00. Continue?',
      'Total: $49.00. Cancelling now will empty your cart. Continue?',
      'Total: $49.00. Cancel within 30 days for a full refund. Continue?',
      'Order confirmed? Cancelling is free for 24 hours. Total: $129.00.',
      // A trial or a sale that will end stops nothing.
      'Your free trial will end today. Continue? ($9.99/month)',
      'Total: $49.00. This sale will end tonight. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a stop through that is asked, told as what will happen or names what it stops', () => {
    for (const message of [
      'Cancel Premium ($9.99/month)?',
      'Are you sure you want to cancel? Your Premium plan ($9.99/month) stays active until March 3.',
      'Your Premium plan ($9.99/month) will be cancelled. Continue?',
      'Your subscription will be cancelled.',
      '구독을 해지하시겠습니까? 다음 결제일부터 요금이 청구되지 않습니다.',
      '取消订阅？（每月 ¥30）取消后可随时重新订阅。',
      // Told as what will happen, or naming what it stops, in any sentence.
      'Your subscription ($9.99/month) will end on March 3. Continue?',
      'Your plan will no longer renew ($9.99/month). Continue?',
      "Your plan won't renew ($9.99/month). Continue?",
      'Your plan is going to be cancelled ($9.99/month). Continue?',
      'We will stop renewing your plan ($9.99/month). Continue?',
      'This item will be removed from your cart. Your new total is $39.00. Continue?',
      '2026년 3월 5일에 해지됩니다. 계속하시겠습니까? (월 9,900원)',
      'プレミアムは3月3日に解約されます。よろしいですか？（月額980円）',
      'プレミアムを解約します。よろしいですか？（月額980円）',
      '멤버십을 해지합니다. 계속하시겠습니까? (월 9,900원)',
      '将取消订阅。确定吗？（每月 ¥30）',
      'Cancel your Premium plan ($9.99/month). Are you sure?',
      'Turn off auto-renew ($9.99/month). Continue?',
      'Unsubscribe from Premium ($9.99/month). Continue?',
      "You're about to cancel Premium ($9.99/month). Continue?",
      'Cancellation of your Premium plan ($9.99/month). Continue?',
      'Cancelling your $9.99/month plan. Continue?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - totals in Korean, Japanese and Chinese, and amounts payable or due', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a total, an amount payable and a balance due', () => {
    for (const message of [
      '총 결제 금액: 49,000원. 계속하시겠습니까?',
      '합계 49,000원. 계속하시겠습니까?',
      'お支払い金額：4,900円。よろしいですか？',
      '合計 4,900円。続けますか？',
      '支付金额：¥49.00。确定吗？',
      '总计 ¥49.00，继续？',
      'Amount payable: $49.00. Proceed?',
      'Balance due: $49.00. Continue?',
      'Amount due today: $49.00. Continue?',
      'Amount to pay: $49.00. OK?',
      // More words for the same.
      'ご請求金額：4,900円。よろしいですか？',
      'Payment amount: $49.00. Continue?',
      'The $5 discount will be removed. Your total will be $49.00. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a refund, a balance shown or a changed amount with none through', () => {
    for (const message of [
      '환불 금액: 49,000원. 계속하시겠습니까?',
      '返金額：4,900円。よろしいですか？',
      '결제 금액이 변경되었습니다. 확인하시겠습니까?',
      'Balance: $49.00. Continue?',
      'Amount refunded: $49.00. Continue?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a negated clause ended by a semicolon or a dash before an amount', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses the amount after the clause', () => {
    for (const message of [
      'You will not be charged for shipping; $49.00 for the item.',
      "You won't be charged for delivery, only for the $49.00 item.",
      'You will not be charged today – $49.00 at delivery. Continue?',
      'You will not be charged today - $49.00 at delivery. Continue?',
      "Your order: $49.00 — you won't be charged until delivery — $5.00 shipping. Continue?",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a clause through that names no amount after it', () => {
    for (const message of [
      "You won't be charged. Continue?",
      "You won't be charged until your trial ends on March 3.",
      "You won't be charged; your trial is free.",
      // An ASCII comma still ends no clause.
      "You won't be charged until your trial ends, then $9.99/month.",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - money given with a tip or a kind of payment', () => {
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('refuses a tip given with its amount and an online or secure payment', () => {
    for (const targetText of [
      'Support with a $5 tip',
      'Say thanks with a $5 tip',
      'Tip with $5',
      'Make an online payment',
      'Make a secure payment',
      'Thank your driver with a $5 tip',
    ]) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });

  it('still lets a page about payments, or a headline with a tip in it, through', () => {
    for (const targetText of [
      'Online payment options',
      'Learn about online payments',
      'How to thank your driver with a $5 tip and why it matters',
      'Say thanks with a $5 gift card',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - token codes and codes in a text', () => {
  const typeInto = (label: string) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field: { label } });

  it('refuses a token code and a code a text or an email brought', () => {
    for (const label of [
      'Tokencode',
      'Token code',
      'We sent a text with a code to (***) ***-1234',
      'We sent you a text message with a code',
      'We sent an email with a code to j***@gmail.com',
    ]) {
      expect(typeInto(label).forbidReason, label).toBe('sensitive_field');
    }
  });

  it('still lets a promo code, a gift card code or a token by itself through', () => {
    for (const label of [
      'Promo code sent by text',
      'Gift card code',
      'API token',
      'We sent an email with a promo code',
    ]) {
      expect(typeInto(label).category, label).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - starts told without be or will', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses an upgrade told in so many words, beside a stop or not', () => {
    for (const message of [
      'Upgraded to Pro automatically. New price: $14.99/month. Continue?',
      'Upgrading you to Pro ($14.99/month). Continue?',
      'Cancel Basic? Upgraded to Pro automatically. New price: $14.99/month.',
      'Cancel Basic? Upgrading you to Pro ($14.99/month).',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets an upgrade done before, or told with no target, through', () => {
    for (const message of [
      'Upgraded successfully. Continue?',
      'Your plan was upgraded on March 3.',
      'Cancel Pro ($14.99/month)? Your plan was upgraded on March 3.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - tips and gifts sent only with an amount', () => {
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('lets a tip or a gift submitted or sent without its amount through', () => {
    for (const targetText of [
      'Submit a tip',
      'Submit tips and tricks',
      'Send us a tip',
      'Send a gift message',
      'Confirm gift message',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });

  it('refuses a tip or a gift confirmed, completed or made, with its amount or without', () => {
    for (const targetText of [
      'Submit $5 tip',
      'Send a $5 gift',
      'Make a donation',
      'Make a $25 donation',
      'Complete your pledge',
      'Make a gift of $25',
      'Send tip',
      'Leave a tip',
      // A delivery app's tip once its amount was chosen; a charity's gift.
      'Confirm tip',
      'Complete your tip',
      'Make a gift',
      'Make a monthly gift',
      'Confirm your gift',
    ]) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - currency codes that are no money', () => {
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('does not take a code before a model or a year that names a thing for an amount', () => {
    for (const targetText of [
      'Send CAD 3D model',
      'Download CAD 2024 files',
      'Open CAD 12 project',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
    expect(accept('Export CAD 2024 drawing? This will cost 5 credits.').category).toBe('act');
  });

  it('still refuses an amount after a code, a year among them', () => {
    for (const message of [
      'Send CAD 500.00 to Jane Doe?',
      'Send CAD 500 to Jane?',
      'Total: AUD 49.00. Continue?',
      'Total: INR 499.00. Proceed?',
      'Send USD 2000 to Jane?',
      'Total: CAD 2024. Continue?',
      'Total: CAD 2024.00. Continue?',
      'Total: EUR 1999. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    expect(click('Pay Rs. 499').forbidReason).toBe('financial_commit');
  });
});

describe("classifyAoiBrowserDriveAction - the Cancel button's whole clause, and the plan's stop", () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a plan stopped with OK, or with what its stop brings, through', () => {
    for (const message of [
      'Click OK to cancel your plan or Cancel to keep it ($9.99/month).',
      'Are you sure? If you cancel, you will lose your Premium benefits ($9.99/month).',
      "If you cancel, you'll keep access until March 3. ($9.99/month)",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses what the Cancel button only describes', () => {
    for (const message of [
      'Total: $49.00. If you cancel, your cart is saved. Continue?',
      'Your order total is $49.00. Click OK to place it, or click Cancel to cancel your order.',
      'Total: $49.00. Cancel now and your cart will be emptied. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a switch onto a way to pay', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('does not take a switch onto PayPal, a card or a bank account for a start', () => {
    for (const message of [
      'Remove this card? You will be switched to PayPal for your $9.99/month plan.',
      'Remove this card? You will be moved to another card for your $9.99/month plan.',
      'Remove this card? You will be switched to your bank account ($9.99/month).',
      'Remove this card? You will be moved to your other credit card ($9.99/month).',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses a switch onto a plan', () => {
    for (const message of [
      'Cancel Basic? You will be upgraded to Pro automatically. New price: $14.99/month.',
      "You'll switch to Pro ($14.99/month). Continue?",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - more headlines', () => {
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('lets ways, reasons and how to pay or donate through', () => {
    for (const targetText of [
      'Best ways to invest $5,000',
      'Why I give $100 monthly',
      'How to donate $25',
      'How to pay $25 online',
      'When to pay $25',
      'Why we give $100 monthly',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });

  it('still refuses paying, donating and investing', () => {
    for (const targetText of ['Pay $25 online', 'Donate $25', 'Invest $5,000', 'Why give $100?']) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });
});

// Round 17: the Cancel button's clause and another answer, a stop told or
// named beside a price of its own elsewhere, a plan chosen for an amount, a
// move onto a free tier, a bare "or Cancel", money paid told with -ing or
// labelled, totals with a qualifier, priced switches behind a stop, and small
// misses.
describe('classifyAoiBrowserDriveAction - the Cancel button clause ends where another answer starts', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses what OK does after a Cancel named first', () => {
    for (const message of [
      'Press Cancel to go back or OK to pay $49.00 now.',
      'Choose Cancel to review your cart or OK to place your order.',
      'Press Cancel to go back or OK and your card will be charged $49.00.',
      'Press Cancel to go back or OK to donate $25.00 to Red Cross.',
      'Upgrade to Premium? Press Cancel to stay on Basic or OK to upgrade for $9.99/month.',
      'Click Cancel to stop or OK to send $50.00 to Jane Doe.',
      'Click Cancel to go back, OK to pay $49.00.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a plan stopped with OK, or a stop told with what it brings, through', () => {
    for (const message of [
      'Click OK to cancel your plan or Cancel to keep it ($9.99/month).',
      'Are you sure? If you cancel, you will lose your Premium benefits ($9.99/month).',
      'Cancel your order of $49.00? Press OK to cancel the order or Cancel to keep it.',
      "If you cancel, you'll keep access until March 3. ($9.99/month)",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a stop told or named speaks for its own sentence', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a purchase that mentions an end, a non-renewal or a refund policy', () => {
    for (const message of [
      "Total: $49.00. Your pass won't renew automatically. Continue?",
      "7-day pass: $14.99. It won't auto-renew. Continue?",
      'Total due today: $14.99. Your access will end on March 10. Continue?',
      '1-year access: $99.00. It will no longer renew after that. Continue?',
      'Total: $99.00 for 12 months. Your membership will end on March 3, 2027. Continue?',
      'Your monthly plan will end today. Total due today: $99.00. Continue?',
      'Change to annual billing? Your monthly plan will end today. Total due today: $99.00.',
      'Your monthly plan will no longer renew. Annual plan: $99.00/year. Continue?',
      'Your monthly plan will end and your annual plan begins today. Total: $99.00. Continue?',
      'Your current plan will be removed. Pro plan ($14.99/month). Continue?',
      "Total due today: $129.00. If you cancel within 24 hours, you'll receive a full refund. Continue?",
      // A named stop speaks for its own sentence too.
      'Your total is $49.00. Cancel your order to get a full refund. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it("still lets a stop through whose amount is its own, a reassurance's, a refund's or the new total", () => {
    for (const message of [
      'Your Premium plan ($9.99/month) will be cancelled. Continue?',
      'This item will be removed from your cart. Your new total is $39.00. Continue?',
      '2026년 3월 5일에 해지됩니다. 계속하시겠습니까? (월 9,900원)',
      'Your subscription ($9.99/month) will end on March 3. Continue?',
      "Your plan won't renew ($9.99/month). Continue?",
      'プレミアムを解約します。よろしいですか？（月額980円）',
      'Your plan will be cancelled. You can rejoin later for $9.99/month. Continue?',
      'Your subscription will be cancelled. Your refund of $4.99 will be sent to your card. Continue?',
      'Cancel your Premium plan ($9.99/month). Are you sure?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a plan chosen for an amount', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a plan, a subscription or a membership chosen for a one-off amount', () => {
    for (const message of [
      'Select the annual plan for $99.00?',
      'Choose Premium Annual for $99.00?',
      'Take the annual plan for $99.00?',
      'Pick the lifetime membership for $199.00?',
      'Pick a plan for your team for $49.00?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a room, a flight, an offer or a seat chosen for an amount through', () => {
    for (const message of [
      'Select this room for $129/night?',
      'Choose this flight for $249.00?',
      "Take the buyer's offer for $45.00?",
      'Pick seat 12A for $25.00?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a cancel that moves onto a free tier', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a move onto a tier said to be free through', () => {
    for (const message of [
      'Cancel your Premium subscription ($9.99/month)? You will be switched to Spotify Free.',
      "Cancel Premium ($9.99/month)? You'll be moved to the Basic plan (free).",
      'Cancel Premium ($9.99/month)? Your account will be switched to Basic, which is free.',
      'Cancel Premium ($9.99/month)? You will be moved to the free tier at no cost.',
      'Cancel Premium ($9.99/month)? You will be moved to Basic ($0).',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses a move onto a paid plan, or a trial that bills', () => {
    for (const message of [
      'Cancel Basic? You will be upgraded to Pro automatically. New price: $14.99/month.',
      "You'll switch to Pro ($14.99/month). Continue?",
      "You'll be moved to Premium (free for 7 days, then $9.99/month).",
      "Cancel Basic? You'll be moved to Premium (free for 7 days, then $9.99/month).",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a bare "or Cancel" names the button', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a payment whose message ends with its buttons', () => {
    for (const message of [
      'Total: $49.00. Press OK to continue or Cancel.',
      'Total: $49.00. Click OK or Cancel.',
      'Amount due: $49.00. Do you want to proceed or cancel?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a question between keeping a plan and cancelling it through', () => {
    expect(accept('Do you want to keep your plan or cancel? ($9.99/month)').category).toBe('act');
  });
});

describe('classifyAoiBrowserDriveAction - money paid told with -ing, or as a labelled amount', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses money paid, bought, donated, labelled or sent by a bare question', () => {
    for (const message of [
      'You are paying $49.00 to Acme Inc. Continue?',
      'You are buying 2 tickets for $49.00. Continue?',
      'You are donating $25.00 to Red Cross. Continue?',
      'Your payment: $49.00. Continue?',
      'Donation amount: $25.00. Continue?',
      '$500.00 to Jane Doe. Send now?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a way to pay, a saving, money paid to the user or an invoice sent through', () => {
    for (const message of [
      'You are paying with Visa ending 4242. Continue?',
      "You're saving $10.00 on this order. Continue?",
      "We're paying you $49.00 for your item. Continue?",
      'Your invoice for $500.00 is ready. Send now?',
      "You're giving away a $5 coupon. Continue?",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - totals with a qualifier or a bracket', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a total with what it includes or counts', () => {
    for (const message of [
      'Total incl. VAT: €49.00. Proceed?',
      'Total for 2 items: $49.00. Continue?',
      'Total (2 items): $49.00. Continue?',
      '合計（税込）：4,900円。よろしいですか？',
      '합계(부가세 포함): 49,000원. 계속하시겠습니까?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a saving or a refund through', () => {
    for (const message of ['Total saved: $10.00. Continue?', 'Total refunded: $49.00. Continue?']) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - priced switches behind a stop', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a switch, an activation, a renewal today or a plan put on', () => {
    for (const message of [
      '베이직을 해지하고 프리미엄(월 14,900원)으로 바꾸시겠습니까?',
      'ベーシックを解約してプレミアム（月額1,480円）に乗り換えますか？',
      '取消基础版，改用专业版（每月 ¥30）？',
      'Remove the free trial? Your membership ($9.99/month) will renew today.',
      'End your trial now? Premium ($9.99/month) will be activated today.',
      "Cancel Basic? You'll be put on Pro ($14.99/month).",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a cancel or a renewal denied through', () => {
    for (const message of [
      '구독을 해지하시겠습니까? 다음 결제일부터 요금이 청구되지 않습니다.',
      'Your membership ($9.99/month) will not renew.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - small misses and false positives of round 17', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });
  const typeInto = (field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field });

  it('refuses a year before VAT, more currencies and an amount after "but"', () => {
    for (const message of [
      'Total: EUR 1999 incl. VAT. Continue?',
      'Send 500 kr to Erik?',
      'Total: 499 kr. Continue?',
      'Total: R 499.00. Continue?',
      'Total: ₺49. Continue?',
      'Total: 49 zł. Continue?',
      'Total: Rp 49.000. Continue?',
      "You won't be charged now, but $49.00 is due at delivery. Continue?",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const targetText of [
      'Pay RM 49.00',
      'Make an extra $50 payment',
      'Submit your one-time $49.00 payment',
      'Give a gift of $25',
    ]) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });

  it('does not take a name, a droid or a headline for money', () => {
    for (const message of ['Kr. Smith will call you. Continue?', 'Watch R2-D2 now?']) {
      expect(accept(message).category, message).toBe('act');
    }
    for (const targetText of ['Watch R2-D2', 'How much to pay $50']) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });

  it('refuses a code under two-step verification, a number sent or a code from an app', () => {
    const fields: AoiBrowserDriveActionField[] = [
      { label: 'Enter code', group: '2-Step Verification' },
      { label: 'Enter code', group: 'Two-step authentication' },
      { label: 'Enter the 6-digit number we sent to your phone' },
      { label: 'Enter the code from your app' },
    ];
    for (const field of fields) {
      expect(typeInto(field).forbidReason, JSON.stringify(field)).toBe('sensitive_field');
    }
    expect(typeInto({ label: 'Enter the 6-digit number on your ticket' }).category).toBe('act');
  });

  it('lets a cancel of a subscription or an automatic deduction through in more words', () => {
    for (const message of [
      '定期購入を停止しますか？',
      '关闭自动扣款？',
      '取消自动扣费？',
      '정기결제(월 9,900원)를 해지하시겠습니까?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a stop that tells the plan as it stands until it ends', () => {
  it('lets a cancel say what the plan costs until then, and still refuses what is bought', () => {
    const accept = (targetText: string) =>
      classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
    for (const message of [
      'Your plan will be cancelled at the end of the period. Your current price is $9.99/month. Continue?',
      "Your subscription will end on March 3. Until then, you'll still have access ($9.99/month).",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
    for (const message of [
      'Total due today: $14.99. Your access will end on March 10. Continue?',
      'Your monthly plan will no longer renew. Annual plan: $99.00/year. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('reads a removal the page reports with its cause as no stop the message asks', () => {
    const accept = (targetText: string) =>
      classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
    for (const message of [
      'One item will be removed because it is out of stock. Your total is now $49.00. Continue?',
      'The gift wrap will be removed as it is unavailable. Total: $49.00. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    // A removal the message asks to make is a stop, its new total no price.
    expect(
      accept('This item will be removed from your cart. Your new total is $39.00. Continue?')
        .category,
    ).toBe('act');
  });
});

// Round 18: the Cancel button's clause ending only at another answer, a paid
// plan with "free" near it, a total whatever qualifies it, "Send?", a removal
// reported with its cause, round-17 rules in ordinary cancels, and common
// cancels that name a billing period, a refunded payment or an amount's label.
describe('classifyAoiBrowserDriveAction - the Cancel button clause ends only where another answer is named', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a total or a rate beside a Cancel whose clause runs on with "and" or "then"', () => {
    for (const message of [
      'Your order total is $49.00. Click OK to continue or Cancel to go back and remove items from your cart.',
      'Your total is $49.00. Press OK to confirm or Cancel to go back and remove items.',
      'Your order total is $49.00. Press Cancel to go back and remove items or OK to continue.',
      'Amount due: $49.00. Click OK to continue or Cancel to go back and stop the payment.',
      'Your order total is $49.00. Click OK to continue or Cancel to go back then remove items',
      'Subscription: $9.99/month. Click OK to continue or Cancel to go back and remove the add-on plan.',
      'Total: $49.00. Click OK to continue or Cancel to go back or remove items.',
      'Press Cancel to go back or OK to pay $49.00 now.',
      'Choose Cancel to review your cart or OK to place your order.',
      'Press Cancel to go back or OK and your card will be charged $49.00.',
      'Press Cancel to go back or OK to donate $25.00 to Red Cross.',
      'Upgrade to Premium? Press Cancel to stay on Basic or OK to upgrade for $9.99/month.',
      'Click Cancel to stop or OK to send $50.00 to Jane Doe.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('refuses another button pressed, a commit offered after "or" and a "but" past the Cancel clause', () => {
    for (const message of [
      'Press Cancel to go back or Continue to pay $49.00.',
      'Click Cancel to go back and click Pay to complete your order of $49.00.',
      'Press Cancel to go back and press Continue to pay $49.00.',
      'Press Cancel to keep shopping or Pay Now to check out ($49.00).',
      'Press Cancel to go back and Confirm to pay $49.00.',
      'Press Cancel to go back then Continue to checkout ($49.00).',
      'Press Cancel to go back but your card will still be charged $49.00.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('lets a cancel through whose Cancel button keeps the plan and its price', () => {
    for (const message of [
      'Press OK to cancel your subscription or Cancel to keep it and pay $9.99/month.',
      'Click OK to cancel your plan or Cancel to keep it ($9.99/month).',
      'Are you sure? If you cancel, you will lose your Premium benefits ($9.99/month).',
      'Cancel your order of $49.00? Press OK to cancel the order or Cancel to keep it.',
      "If you cancel, you'll keep access until March 3. ($9.99/month)",
      'Click Cancel to go back and select another plan for $4.99/month.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a paid plan with "free" near it is no move onto a free tier', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a move onto a plan that its sentence prices after the free words', () => {
    for (const message of [
      "Cancel your Basic plan? You'll be upgraded to Pro with 1 month free, then $14.99/month.",
      "Cancel Basic? You'll be switched to Premium plus free shipping for $14.99/month.",
      "Cancel Basic? You'll be upgraded to Pro for $0 today, then $14.99/month.",
      "Cancel Basic? You'll be moved to the annual plan, which is free for the first month, then $99/year.",
      "Cancel Basic? You'll be upgraded to Pro (1 month free), then $14.99/month.",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('lets a move onto a free plan through, at $0 too', () => {
    for (const message of [
      'Cancel your Premium subscription ($9.99/month)? You will be switched to Spotify Free.',
      "Cancel Premium ($9.99/month)? You'll be moved to the Basic plan (free).",
      'Cancel Premium ($9.99/month)? Your account will be switched to Basic, which is free.',
      "Cancel Premium ($9.99/month)? You'll be moved to Basic ($0).",
      "Your Premium plan ($9.99/month) will be cancelled and you'll be moved to the Free plan.",
      "Cancel Premium? You'll be moved to Basic for $0.",
      "Cancel Premium? You'll be moved to Basic for $0.00/month.",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a total keeps its price whatever qualifies it', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a total or an amount due beside a told stop, whatever excuse its sentence holds', () => {
    for (const message of [
      '1 item will be removed from your order. Total: $49.00 (taxes may apply). Continue?',
      'Your monthly plan will end today. Total due today: $99.00 (taxes may apply). Continue?',
      'Your monthly plan will end today. Total due today: $99.00 (you can cancel anytime). Continue?',
      'Your monthly plan will end today. Total due today: $99.00 (minus a $4.50 credit for your unused days). Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a new total, the current price and the access until then through', () => {
    for (const message of [
      'This item will be removed from your cart. Your new total is $39.00. Continue?',
      'Your plan will be cancelled at the end of the period. Your current price is $9.99/month. Continue?',
      "Your subscription will end on March 3. Until then, you'll still have access ($9.99/month).",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - "Send?" asked bare', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses an amount sent by "Send?", "Send it?" or "Send this?"', () => {
    for (const message of [
      '$500.00 to Jane Doe. Send?',
      '$500.00 to Jane Doe. Send it?',
      'Transfer of $500.00 to Jane Doe. Send this?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    expect(accept('Your invoice for $500.00 is ready. Send?').category).toBe('act');
  });

  it('refuses a payment of an amount tried again by "Retry?" or "Try again?"', () => {
    for (const message of [
      'Payment declined ($49.00). Retry?',
      'Last payment: $49.00 (declined). Retry?',
      'Your payment of $49.00 failed. Try again?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const message of [
      'Upload failed. Retry?',
      "Couldn't send your invoice for $500.00. Retry?",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a removal reported with its cause', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses the order that goes on after a removal the page reports, asked or not', () => {
    for (const message of [
      'One item was cancelled because it is out of stock. Your total is now $49.00. Click OK to continue.',
      'One item will be removed because it is out of stock. Your total is now $49.00.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('lets a cancel told with its cause through where no other sentence states a total', () => {
    for (const message of [
      'Your subscription ($9.99/month) will be cancelled due to a failed payment. Continue?',
      'Your subscription will be cancelled because you requested it. $9.99/month will no longer be charged.',
      'Your order ($49.00) will be cancelled because an item is out of stock. Continue?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - round-17 start words and rules in ordinary cancels', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });
  const typeInto = (field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field });
  const selectIn = (field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind: 'select', selector: '#f', value: '1', field });

  it('lets a hold, a refund put back, a free plan activated and a renewal turned off through', () => {
    for (const message of [
      'Pause your subscription ($9.99/month)? Your subscription will be put on hold for 1 month.',
      'Pause your membership ($9.99/month)? Your membership will be placed on hold until May.',
      'Cancel this order ($49.00)? Your refund will be put on your original payment method.',
      'Cancel your order ($49.00)? Your credit will be moved to your account balance.',
      'Cancel your Premium plan ($9.99/month)? Your free plan will be activated.',
      'Cancel Premium ($9.99/month)? Spotify Free will start on March 3.',
      'Turn off auto-renew? Your plan will renew today unless you turn it off ($9.99/month).',
      'Turn off auto-renew? Your plan will renew today, unless you turn it off ($9.99/month).',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses a free account upgraded, a free trial or an ad-free plan activated and a renewal today', () => {
    for (const message of [
      'Your free account will be upgraded to Pro ($9.99/month). Continue?',
      'End Basic? Your free trial of Premium will be activated ($9.99/month after 7 days).',
      'Cancel Basic? Your Ad-Free plan will be activated at $4.99/month.',
      'Remove the free trial? Your membership ($9.99/month) will renew today.',
      'Your plan renews today ($9.99/month). Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('lets a CJK move onto a free plan and a Korean Cancel button described through', () => {
    for (const message of [
      'プレミアムプラン（月額980円）を解約しますか？解約後は無料プランに移行します。',
      '取消会员（每月¥15）？取消后将改用免费版。',
      '取消会员（每月¥15）？取消后将切换到免费版。',
      '구독(월 9,900원)을 해지하시겠습니까? 다른 요금제로 바꾸시려면 취소를 누르세요.',
      '다른 요금제로 변경을 원하시면 취소를 누르세요. 구독(월 9,900원)을 해지하시겠습니까?',
      '구독(월 9,900원)을 해지하시겠습니까? 무료 요금제로 변경됩니다.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
    for (const message of [
      '프리미엄(월 14,900원)으로 변경하시려면 확인을, 유지하시려면 취소를 누르세요.',
      '取消会员？将改用专业版（每月¥30）。',
      '베이직을 해지하고 프리미엄(월 14,900원)으로 바꾸시겠습니까?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('reads a "but" as still charged only right before an amount', () => {
    for (const message of [
      'Cancel your plan? You will not be billed again, but your $9.99/month plan stays active until March 3.',
      "Unsubscribe? You won't be charged anymore, but you can resubscribe for $9.99/month at any time.",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
    for (const message of [
      "You won't be charged now, but $49.00 is due at delivery. Continue?",
      "You won't be charged now, but only $49.00 at delivery.",
      "You won't be charged now, but the remaining $49.00 is due at delivery. Continue?",
      "You won't be charged now, but your remaining $49.00 is due at delivery. Continue?",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('lets a payment already made through as a label, and still refuses one retried', () => {
    for (const message of [
      'Your last payment: $49.00 on March 3. View the receipt?',
      'Last payment amount: $49.00. View details?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
    for (const message of [
      'Payment: $49.00. Continue?',
      'Your last payment of $49.00 failed. Try again?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('reads a bare R, RM or Rp as money only before two digits or a decimal part', () => {
    expect(click('Send logs to R2').category).toBe('act');
    for (const message of [
      'Total: R 499.00. Continue?',
      'Total: R 49.00. Continue?',
      'Total: R 499. Continue?',
      'Total: R49. Continue?',
      'Send R50 to John?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('reads two-step verification as a code field, not as a phone or a method', () => {
    const allowed: AoiBrowserDriveActionField[] = [
      { type: 'tel', autocomplete: 'tel', label: 'Phone number', group: '2-Step Verification' },
      { label: 'Phone number', group: 'Two-step verification' },
      { autocomplete: 'tel', group: '2-step verification' },
      { label: '2-step verification method' },
      { label: 'Verification method', group: '2-Step Verification' },
      { label: 'Remember this device', group: '2-Step Verification' },
    ];
    for (const field of allowed) {
      expect(typeInto(field).category, JSON.stringify(field)).toBe('act');
    }
    expect(selectIn({ label: '2-step verification method' }).category).toBe('act');
    const refused: AoiBrowserDriveActionField[] = [
      { label: 'Enter code', group: '2-Step Verification' },
      { label: '2-step verification code' },
      { label: 'Code', type: 'tel', group: '2-Step Verification' },
      { label: 'Enter the code', group: 'Set up 2-step verification' },
      { label: 'Enter the 6 digits', group: '2-Step Verification' },
    ];
    for (const field of refused) {
      expect(typeInto(field).forbidReason, JSON.stringify(field)).toBe('sensitive_field');
    }
    const prompt = (targetText: string) =>
      classifyAoiBrowserDriveAction({
        kind: 'dialog',
        disposition: 'accept',
        promptText: '1',
        targetText,
      });
    expect(prompt('Enter your 2-step verification code').forbidReason).toBe('sensitive_field');
    expect(prompt('Enter the phone number for 2-step verification').category).toBe('act');
  });
});

describe('classifyAoiBrowserDriveAction - cancels that name a billing period, a refunded payment or an amount label', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('lets a cancel through that names the billing period or a payment refunded', () => {
    for (const message of [
      'Cancel subscription? You will lose access to Premium features at the end of the current billing period ($9.99/month).',
      'Cancel subscription? Your next billing date was March 3 ($9.99/month).',
      'Are you sure you want to cancel your order? Your payment of $49.00 will be refunded within 5 days.',
      'Your payment of $49.00 has been reversed. OK?',
      'Your payment of $49.00 to Acme will be refunded. Continue?',
      'Your payment of 49,000원 will be refunded. Continue?',
      '注文をキャンセルしますか？お支払い金額4,900円は返金されます。',
      '确定取消订单吗？支付金额¥49.00将原路退回。',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses billing that starts, a payment processed and a total in Japanese', () => {
    for (const message of [
      'Total: $49.00. Billing starts today. Continue?',
      'Billing cycle: monthly ($9.99/month). Continue?',
      'Your payment of $49.00 will be processed now. Continue?',
      'Your payment of $49.00 will be processed and $5.00 returned as credit. Continue?',
      'Continue? Your payment of $49.00 will not be refunded.',
      "Continue? Your payment of $49.00 won't be refunded.",
      'お支払い金額：4,900円。よろしいですか？',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('reads an amount label as no pay button, and a pay word still as one', () => {
    for (const targetText of ['お支払い金額', '支付金额', '付款金额']) {
      expect(click(targetText).category, targetText).toBe('act');
    }
    for (const targetText of ['支払う', '立即支付', '付款']) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });
});

// Round 19: what happens if Cancel is not pressed, CJK amounts with a
// particle, two-step code fields, conditional refunds, ringgit and rupiah,
// CJK free trials, free plans priced later, repeated payments, refund totals,
// refunds after a free move, retries, the CJK Cancel button, Korean and
// Japanese order questions, and the reviewer's sweeps.
describe('classifyAoiBrowserDriveAction - the Cancel clause ends where "or" tells a charge', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses what is charged or paid if Cancel is not pressed, and another button selected', () => {
    for (const message of [
      'Click Cancel to go back or your card will be charged $49.00.',
      'Press Cancel to go back or you will be charged $49.00.',
      'Press Cancel to stop or we will charge your card $49.00 now.',
      'Select Cancel to go back or select Pay Now to pay $49.00.',
      'Press Cancel to go back or Enter to pay $49.00.',
      'Choose Cancel to go back or choose Place Order to pay $49.00.',
      'Press Cancel to go back or $49.00 will be charged to your Visa.',
      'Press Cancel to go back or you will pay $49.00 now.',
      "Press Cancel to keep shopping or we'll place your order for $49.00 now.",
      'Hit Cancel to stop or the $49.00 payment will go through.',
      'Press Cancel to go back or your $49.00 order will be placed.',
      'Press Cancel to go back otherwise you will be charged $49.00.',
      'Press Cancel now or else your card will be charged $49.00.',
      'Press Cancel to go back and select Pay Now to pay $49.00.',
      'Press Cancel to go back or use Apple Pay to pay $49.00.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets the Cancel button keep the plan, go back or choose another plan', () => {
    for (const message of [
      'Press OK to cancel your subscription or Cancel to keep it and pay $9.99/month.',
      'Click OK to cancel your plan or Cancel to keep it ($9.99/month).',
      'Cancel your order of $49.00? Press OK to cancel the order or Cancel to keep it.',
      'Click Cancel to go back and select another plan for $4.99/month.',
      'Cancel your order ($49.00)? Press Cancel to go back or edit your order.',
      'Cancel your order ($49.00)? Press Cancel to go back or you will lose your cart.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - CJK payment amounts with a particle', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a total whose label is joined to its amount by a particle', () => {
    for (const message of [
      'お支払い金額は4,900円です。よろしいですか？',
      'お支払い金額は4,900円になります。よろしいですか？',
      '本次支付金额为¥49.00，确定继续吗？',
      '付款金额是¥49.00，确定继续吗？',
      '결제 금액은 49,000원입니다. 계속하시겠습니까?',
      '합계 금액은 49,000원입니다. 계속하시겠습니까?',
      '총 금액은 49,000원입니다. 계속할까요?',
      '合計金額は4,900円です。よろしいですか？',
      'ご注文金額は4,900円です。よろしいですか？',
      '总金额为¥49.00，确定吗？',
      '订单金额为¥49.00，确定继续吗？',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a refunded amount and a button that shows the amount through', () => {
    for (const message of [
      '注文をキャンセルしますか？お支払い金額4,900円は返金されます。',
      '确定取消订单吗？支付金额¥49.00将原路退回。',
      '환불 금액은 4,900원입니다. 계속하시겠습니까?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
    expect(
      classifyAoiBrowserDriveAction({
        kind: 'click',
        selector: '#x',
        targetText: 'お支払い金額を確認',
      }).category,
    ).toBe('act');
  });
});

describe('classifyAoiBrowserDriveAction - two-step code fields', () => {
  const typeInto = (field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field });
  const group = '2-Step Verification';

  it('refuses a code field whatever it says the code comes from, and one with no words', () => {
    const fields: AoiBrowserDriveActionField[] = [
      { group, label: 'Enter the code from your phone' },
      { group, label: 'Enter the code from your mobile app' },
      { group, label: 'Mobile code' },
      { group, label: 'Code', id: 'phone-code' },
      { group, label: 'Enter the code shown on your phone' },
      { group, label: 'Enter the number we sent to your phone' },
      { group },
      { group, id: 'd1' },
      { group, name: 'input_3' },
      { group, label: 'Character 1 of 6' },
      { group, autocomplete: 'off' },
      { group: 'Two-step authentication', placeholder: '123456' },
    ];
    for (const field of fields) {
      expect(typeInto(field).forbidReason, JSON.stringify(field)).toBe('sensitive_field');
    }
  });

  it('still lets a phone number, a method, an email and a dialling prefix through', () => {
    const fields: AoiBrowserDriveActionField[] = [
      { type: 'tel', autocomplete: 'tel', label: 'Phone number', group },
      { label: 'Mobile number', group },
      { label: 'Backup phone number', group },
      { autocomplete: 'tel', group },
      { label: 'Verification method', group },
      { label: 'Recovery email', group },
      { label: 'Country/area code', group },
      { label: 'Country code', group },
    ];
    for (const field of fields) {
      expect(typeInto(field).category, JSON.stringify(field)).toBe('act');
    }
    for (const label of ['2-step verification method', '2-step verification option']) {
      expect(
        classifyAoiBrowserDriveAction({
          kind: 'select',
          selector: '#f',
          value: '1',
          field: { label },
        }).category,
        label,
      ).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a refund only promised on a condition', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a payment whose refund comes only if, when or unless something happens', () => {
    for (const message of [
      'Start your membership? Your payment of $49.00 is refunded if you cancel in 14 days.',
      'Your first payment of $49.00 will be refunded in full if you cancel within 30 days. Subscribe now?',
      'Your payment of $49.00 will be refunded if your flight is delayed. Continue?',
      'Reserve your spot? A payment of $25.00 will be refunded when you attend.',
      "Your payment of $49.00 will be cancelled if you don't confirm within 10 minutes. Confirm?",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a payment refunded, reversed or called off through', () => {
    for (const message of [
      'Are you sure you want to cancel your order? Your payment of $49.00 will be refunded within 5 days.',
      'Cancel your subscription? Your next payment of $9.99 on March 3 will be cancelled.',
      'Your next payment of $9.99 will be stopped. Continue?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - ringgit and rupiah of one digit', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('reads RM and Rp before any digit as money, and a bare R before one digit as none', () => {
    for (const targetText of ['Tip RM2', 'Tip RM5', 'Give RM5']) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
    for (const message of [
      'Total: RM8. Proceed?',
      'Send RM5 to Ali?',
      'This will cost RM9 per month. Continue?',
      'Total: Rp5. Proceed?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const targetText of ['Send logs to R2', 'Export to R2', 'Send R5 to John']) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - CJK moves onto a free trial or a free plan priced later', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a move onto a free trial, and one onto a free plan a later price pays for', () => {
    for (const message of [
      '베이직 요금제를 해지하고 프로 무료 체험으로 변경하시겠습니까? 체험 종료 후 월 14,900원',
      'ベーシックプランを解約して、プロの無料体験に切り替えますか？体験終了後は月額1,480円です。',
      '要取消基础版并切换到免费试用吗？试用结束后每月¥30。',
      '베이직을 해지하고 1개월 무료 프로 요금제로 변경하시겠습니까? 이후 월 9,900원',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a cancel that moves onto a free plan through', () => {
    for (const message of [
      'プレミアムプラン（月額980円）を解約しますか？解約後は無料プランに移行します。',
      '取消会员（每月¥15）？取消后将改用免费版。',
      '取消会员（每月¥15）？取消后将切换到免费版。',
      '구독(월 9,900원)을 해지하시겠습니까? 무료 요금제로 변경됩니다.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a free plan that will start, priced later', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a free plan started or activated that its sentence or a later one prices', () => {
    for (const message of [
      'Switch plans? Basic will be cancelled and free Premium will be activated for 30 days, then $14.99/month.',
      'Cancel your Basic plan? Free Premium will start today. After 30 days, $14.99/month.',
      'Cancel Basic? Free Pro will be activated today, then $14.99/month.',
      'Cancel Basic? Free Pro starts today. Then $14.99/month.',
      'Cancel Basic? Your free trial of Pro starts today. Then $14.99/month.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a free plan through that only the stopped plan prices', () => {
    for (const message of [
      'Cancel your Premium plan ($9.99/month)? Your free plan will be activated.',
      'Your free plan will be activated. Your Premium plan ($9.99/month) will be cancelled. Continue?',
      'Cancel Premium ($9.99/month)? Your free plan starts today.',
      'Cancel Basic? Free Premium will start today. Your current plan: $9.99/month.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a past payment repeated', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a past payment the message asks to repeat or send again', () => {
    for (const message of [
      'Repeat last payment: $49.00 to Acme Inc.?',
      'Previous payment: $49.00. Repeat it?',
      'Previous payment: $49.00. Make it again?',
      'Last payment: $49.00 to Jane Doe. Send again?',
      'You sent $49.00 to Jane Doe on March 3. Send again?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a past payment shown through', () => {
    for (const message of [
      'Your last payment: $49.00 on March 3. View the receipt?',
      'Cancel your plan? Your last payment: $9.99 on March 3.',
      'Repeat your last search?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a told cancel with a refund total', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a cancel through whose total is the refund', () => {
    for (const message of [
      'Your order will be cancelled. Refund total: $49.00. Continue?',
      'Your order will be cancelled. Your refund total is $49.00. Continue?',
      'Your order will be cancelled. Order total: $49.00 will be refunded to your card. Continue?',
      'Your order will be cancelled and refunded. Total: $49.00 (refund to original payment method). Continue?',
      'Your order will be cancelled because the item is sold out. Refund total: $49.00. Continue?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses a total that qualifies what is paid', () => {
    for (const message of [
      '1 item will be removed from your order. Total: $49.00 (taxes may apply). Continue?',
      'Your monthly plan will end today. Total due today: $99.00 (taxes may apply). Continue?',
      'Your monthly plan will end today. Total due today: $99.00 (you can cancel anytime). Continue?',
      'Your monthly plan will end today. Total due today: $99.00 (minus a $4.50 credit for your unused days). Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a refund, a credit or a stopped charge after a free move', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a move onto a free plan through beside money given back or a charge that stops', () => {
    for (const message of [
      "Cancel your Premium subscription ($9.99/month)? You'll be switched to the Free plan and get a prorated refund of $4.99.",
      "Cancel Premium ($9.99/month)? You'll be moved to the free plan and keep your $5 credit.",
      'Cancel Premium? You will be moved to the Free plan, and your $9.99/month charge will stop.',
      "Cancel Premium? You'll be moved to Basic ($0) today, and your $9.99 Premium charge stops.",
      'Cancel Premium? You will be moved to the Free plan on March 3, when your $9.99/month billing period ends.',
      "Cancel your Premium plan? You'll be switched to Free, and you'll no longer pay $9.99/month.",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses a free move its sentence prices', () => {
    for (const message of [
      "Cancel your Basic plan? You'll be upgraded to Pro with 1 month free, then $14.99/month.",
      "Cancel Basic? You'll be switched to Premium plus free shipping for $14.99/month.",
      "Cancel Basic? You'll be upgraded to Pro for $0 today, then $14.99/month.",
      "Cancel Basic? You'll be moved to the annual plan, which is free for the first month, then $99/year.",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - "Retry?" and "Try again?" with money moving', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a retry through whose message moves no money', () => {
    for (const message of [
      "Couldn't save your price alert for $199.99. Try again?",
      "Couldn't update your budget to $500. Try again?",
      "We couldn't load your $25 gift card balance. Try again?",
      "Your message 'Can you lend me $20?' failed to send. Retry?",
      "We couldn't apply your $5 coupon. Try again?",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses a payment, a transfer, an order or a charge tried again', () => {
    for (const message of [
      'Payment declined ($49.00). Retry?',
      'Your payment of $49.00 failed. Try again?',
      'Transfer of $500.00 failed. Retry?',
      "We couldn't complete your order of $49.00. Try again?",
      'Charge failed for $49.00. Retry?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a CJK confirm that names its own Cancel button', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses the total beside a Cancel button described in Japanese, Korean or Chinese', () => {
    for (const message of [
      '合計：4,900円。よろしければ「OK」を、戻る場合は「キャンセル」を押してください。',
      '총 결제 금액: 49,000원. 계속하려면 확인을, 돌아가려면 취소를 누르세요.',
      '合计：¥49.00。确认请点“确定”，返回请点“取消”。',
      '합계: 4,900円。よろしければOKを、やめる場合はキャンセルを押してください。',
      '合計：4,900円。キャンセルボタンを押すとカートに戻ります。',
      '결제를 취소하시려면 취소 버튼을 눌러 주세요. 결제 금액: 49,000원',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a CJK stop through beside its Cancel button described', () => {
    for (const message of [
      '구독(월 9,900원)을 해지하시겠습니까? 다른 요금제로 바꾸시려면 취소를 누르세요.',
      '구독(월 9,900원)을 해지하시겠습니까? 해지를 원하지 않으시면 취소를 누르세요.',
      '他のプランに変更する場合はキャンセルを押してください。プレミアム（月額980円）を解約しますか？',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - Korean and Japanese order questions', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses an order asked for, and lets an order told of through', () => {
    for (const message of [
      '총 49,000원입니다. 주문하시겠습니까?',
      '합계 4,900円です。注文しますか？',
      'ご注文を送信しますか？（4,900円）',
      '주문 금액은 49,000원입니다. 주문을 진행할까요?',
      '주문 하시겠습니까? 49,000원',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const message of [
      '주문하신 상품이 발송되었습니다. 확인하시겠습니까?',
      '주문을 취소하시겠습니까?',
      '주문 내역을 확인하시겠습니까?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - top-ups, rentals, orders placed and cancels from the sweeps', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('refuses a top-up, a rental priced, an order told as placed and a tip to someone', () => {
    for (const message of [
      'Add $10 to your wallet?',
      'Reload $25 to your Starbucks Card?',
      "Rent 'Dune' for $3.99?",
      'Your order will be placed. Continue?',
      'Tip your rider RM3?',
      'Do not pay $49.00 to anyone who calls you. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const targetText of ['Add $10 to wallet', 'Load $20 to card', 'Tip your driver $3']) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });

  it('lets a cart amount, a rental again, an order on hold and a payment stopped through', () => {
    for (const message of [
      'Add $10 to your cart?',
      'Cancel your rental? You can rent again for $3.99.',
      'Your order will be placed on hold. Continue?',
      'Cancel your subscription? You will no longer pay $9.99/month.',
      "Cancel your subscription? You won't be charged your next payment of $9.99 on March 3.",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
    expect(click('Never pay full price again').category).toBe('act');
  });
});

// Round 20: the CJK Cancel button's words kept where they could be what OK
// pays, declined cards retried, payments that cannot be called off, a negated
// payment an until-OK clause gives back, charges that stop beside a fee, "or"
// with a longer subject, phone fields under two-step verification, a free
// start beside the plan as it stands, CJK refund totals, receipts resent, 주문
// with a particle, a stop clause ended by a dash, past order notices, and the
// reviewer's sweeps.
describe('classifyAoiBrowserDriveAction - the CJK Cancel button keeps what OK pays', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a payment that shares its clause with the Cancel button', () => {
    for (const message of [
      '확인 버튼을 누르면 49,000원이 결제되며 취소 버튼을 누르면 결제가 취소됩니다.',
      '확인을 누르시면 결제가 진행되며 취소를 누르시면 이전 화면으로 돌아갑니다.',
      '취소를 누르면 돌아가고 확인을 누르면 결제가 진행됩니다.',
      '4,900円をお支払いいただきます キャンセルを押すと戻ります',
      '确认购买请点“确定” 返回请点“取消”',
      '결제 금액 49,000원 확인을 누르면 결제되고 취소를 누르면 돌아갑니다.',
      '「キャンセル」を押さないと980円が請求されます。',
      '결제를 취소하시려면 취소 버튼을 눌러 주세요. 결제 금액: 49,000원',
      'キャンセルを押すと戻り OKを押すと購入が確定します',
      '点击“取消”返回 点击“确定”立即支付',
      '취소를 누르지 않으면 9900원이 결제됩니다.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still takes the Cancel button out of a CJK cancel or a plain choice', () => {
    for (const message of [
      '구독(월 9,900원)을 해지하시겠습니까? 다른 요금제로 바꾸시려면 취소를 누르세요.',
      '구독(월 9,900원)을 해지하시겠습니까? 해지를 원하지 않으시면 취소를 누르세요.',
      '他のプランに変更する場合はキャンセルを押してください。プレミアム（月額980円）を解約しますか？',
      '계속하려면 확인을, 돌아가려면 취소를 누르세요.',
      '정말 삭제하시겠습니까? 취소를 누르면 돌아갑니다.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a declined card or a failed booking tried again', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a declined card, missing funds, an authorization or a booking retried', () => {
    for (const message of [
      'Your card was declined ($49.00). Try again?',
      'Card declined ($49.00). Retry?',
      'Insufficient funds for $49.00. Try again?',
      'Authorization for $49.00 failed. Retry?',
      'Your bank declined $49.00. Retry now?',
      'Booking for $129.00 failed. Try again?',
      'Top-up of $20.00 failed. Retry?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    expect(accept("Couldn't save your price alert for $199.99. Try again?").category).toBe('act');
  });
});

describe('classifyAoiBrowserDriveAction - a payment that cannot be called off', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a payment that cannot, only can or unless is cancelled', () => {
    for (const message of [
      'Your payment of $49.00 cannot be cancelled. Continue?',
      'Your payment of $49.00 can only be cancelled within 24 hours. Continue?',
      'Your payment of $49.00 cannot be voided after today. Continue?',
      'Your payment of $49.00 is scheduled for today unless cancelled. Continue?',
      'Your payment of $49.00 to Acme cannot be cancelled once it is sent. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    expect(
      accept('Your next payment of $9.99 on March 3 will be cancelled. Continue?').category,
    ).toBe('act');
  });
});

describe('classifyAoiBrowserDriveAction - a negated payment given back by an until-OK clause', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses the payment that accepting charges, and lets a payment not charged through', () => {
    for (const message of [
      "You won't be charged your first payment of $49.00 until you click OK.",
      "You won't be charged your first payment of $49.00 until you press OK. Continue?",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    expect(accept("You won't be charged your next payment of $9.99. Continue?").category).toBe(
      'act',
    );
  });
});

describe('classifyAoiBrowserDriveAction - charges that stop beside a fee', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a fee told after charges or billing that stop', () => {
    for (const message of [
      'Your monthly charges will end and a one-time fee of $25.00 is due now. Continue?',
      'Your charges will stop on March 3 and a $25.00 early cancellation fee applies.',
      'Billing will end today and a final charge of $49.00 will be made.',
      'Your $9.99/month charges will stop and you will pay a $25.00 fee today. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets charges that stop through', () => {
    for (const message of [
      'Cancel Premium? You will be moved to the Free plan, and your $9.99/month charge will stop.',
      'Your charges will stop and your plan will end on March 3. Continue?',
      'Your $9.99/month charge will stop. Continue?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - "or" with a longer subject or an adverb', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses what is charged, deducted, transferred or withdrawn if Cancel is not pressed', () => {
    for (const message of [
      'Press Cancel to go back or your card on file will be charged $49.00.',
      'Ready to continue? Press Cancel to go back or your card will automatically be charged $49.00.',
      'Press Cancel to go back or your card will now be charged $49.00.',
      "Press Cancel to go back or you'll automatically be charged $49.00.",
      'Press Cancel to go back or $49.00 will be deducted from your account.',
      'Press Cancel to go back or $49.00 will be transferred to Jane.',
      'Press Cancel to go back or $49.00 will be withdrawn.',
      'Press Cancel to go back or your purchase of $49.00 will be completed.',
      'Press Cancel to go back or your Visa ending in 4242 will be charged.',
      'Ready to continue? Press Cancel to go back or your subscription will renew at $9.99/month.',
      'Ready to continue? Press Cancel to go back or $49.00 is charged to your card.',
      "Ready to continue? Press Cancel to go back or we'll go ahead and charge $49.00.",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets the Cancel button keep a plan, choose another or remove an item', () => {
    for (const message of [
      'Press OK to cancel your subscription or Cancel to keep it and pay $9.99/month.',
      'Cancel your Premium plan ($9.99/month)? Press Cancel to keep it or select another plan.',
      'Cancel your membership? Click Cancel to keep it or choose Pause instead.',
      'Delete this saved card? Press Cancel to keep it or use another card.',
      'Remove this item from your cart? Press Cancel to keep it or else it will be removed.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - phone fields on a two-step set-up page', () => {
  const typeInto = (field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field });
  const setUp = 'Set up 2-Step Verification';
  const group = '2-Step Verification';

  it('lets a field that names a phone number or an email address first through', () => {
    const fields: AoiBrowserDriveActionField[] = [
      {
        label: 'Mobile number',
        type: 'tel',
        placeholder: 'Enter 10-digit mobile number',
        group: setUp,
      },
      { label: "Mobile number – we'll text you a code", type: 'tel', group: setUp },
      { label: 'Phone number to receive codes', type: 'tel', group: setUp },
      { type: 'tel', placeholder: '(555) 555-5555', group: setUp },
      { type: 'tel', placeholder: '+1 555 555 5555', group: setUp },
      { type: 'tel', id: 'phone', label: 'Where should we send your codes?', group },
      { type: 'email', label: 'Email address to send codes to', group },
    ];
    for (const field of fields) {
      expect(typeInto(field).category, JSON.stringify(field)).toBe('act');
    }
  });

  it('still refuses a code field whatever phone it names after the code', () => {
    const fields: AoiBrowserDriveActionField[] = [
      { group, label: 'Enter the code from your phone' },
      { group, label: 'Mobile code' },
      { group, label: 'Code', id: 'phone-code' },
      { group, label: 'Enter the code sent to your mobile number' },
      { group, label: 'Mobile number verification code' },
      { group, id: 'd1' },
      { group, placeholder: '123456' },
      { group, placeholder: '000000' },
    ];
    for (const field of fields) {
      expect(typeInto(field).forbidReason, JSON.stringify(field)).toBe('sensitive_field');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a free start beside the plan as it stands', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a free start through beside the price kept until then or one already paid', () => {
    for (const message of [
      'Cancel your membership? Your free account will be activated on March 3. Premium ($9.99/month) stays active until then.',
      'Cancel Premium? Your Free plan will start when your current billing period ends. Your last payment was $9.99.',
      'プレミアムを解約しますか？解約後は無料プランに移行します。プレミアム（月額980円）は3月3日までご利用いただけます。',
      '프리미엄을 해지하시겠습니까? 해지 후 무료 요금제로 변경됩니다. 프리미엄(월 9,900원)은 3월 3일까지 이용할 수 있습니다.',
      '要取消会员吗？取消后将改用免费版。会员（每月¥15）可使用至3月3日。',
      "Cancel subscription? Your free plan will be activated on March 3. You've already been charged $9.99 for this month.",
      'Cancel Premium? Your free plan starts on March 3. Premium is $9.99/month if you change your mind.',
      "Cancel your Premium plan? Your free plan starts on March 3. You'll keep Premium ($9.99/month) until then.",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses a free start or move that a later price pays for', () => {
    for (const message of [
      'Cancel your Basic plan? Free Premium will start today. After 30 days, $14.99/month.',
      'Switch plans? Basic will be cancelled and free Premium will be activated for 30 days, then $14.99/month.',
      '베이직을 해지하고 1개월 무료 프로 요금제로 변경하시겠습니까? 이후 월 9,900원',
      'Continue? Free Pro starts today. Then $14.99/month.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - CJK refund totals', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a cancel through whose total is a refund, told or done', () => {
    for (const message of [
      '주문이 취소됩니다. 환불 합계는 49,000원입니다. 계속하시겠습니까?',
      'ご注文はキャンセルされます。返金合計は4,900円です。よろしいですか？',
      '订单将被取消。退款总额为¥49.00。确定继续吗？',
      '주문이 취소됩니다. 환불 합계: 49,000원. 계속하시겠습니까?',
      '주문이 취소되었습니다. 환불 합계는 49,000원입니다. 확인하시겠습니까?',
      'ご注文はキャンセルされました。返金総額は4,900円です。よろしいですか？',
      '订单已取消。退款总额：¥49.00。确定吗？',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
    for (const message of [
      'お支払い金額は4,900円です。よろしいですか？',
      '결제 금액은 49,000원입니다. 계속하시겠습니까?',
      '本次支付金额为¥49.00，确定继续吗？',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a receipt resent, and a past order or donation repeated', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a receipt, an invoice or a confirmation resent through', () => {
    for (const message of [
      'Last payment: $49.00 on March 3. Resend receipt?',
      'Last payment: $49.00 on March 3. Send the receipt again?',
      'Previous payment: $49.00. Resend the confirmation email?',
      'Previous payment: $49.00 (March 3). Resend invoice?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses a past payment, order, transfer or donation repeated', () => {
    for (const message of [
      'Repeat last payment: $49.00 to Acme Inc.?',
      'Previous payment: $49.00. Repeat it?',
      'Last payment: $49.00 to Jane Doe. Send again?',
      'Last order: $49.00 (2 items). Reorder?',
      'Your last order: $49.00. Order again?',
      'Last transfer: $500.00 to Jane Doe. Repeat?',
      'Previous donation: $25.00. Give again?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - 주문 with a particle, and orders told as placed', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('refuses an order completed with a particle, and lets a done order through', () => {
    for (const message of [
      '확인을 누르면 주문이 완료되고 취소를 누르면 장바구니로 돌아갑니다.',
      '주문을 완료하시겠습니까?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const message of [
      '주문이 완료되었습니다. 영수증을 보시겠습니까?',
      'ご注文を完了しました。領収書を送信しますか？',
      'ご注文を送信しました。確認メールを送信しますか？',
      '您已下单，是否查看订单？',
      '下单成功，是否查看订单？',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
    for (const targetText of ['注文を確定する', 'ご注文を送信', '提交订单', '下单']) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a stop clause ended by a dash', () => {
  it('refuses a new plan priced after the stop and a dash', () => {
    const message =
      "Continue? You'll be upgraded to Pro with 1 month free and your Basic plan will be cancelled - Pro is $14.99/month after that.";
    expect(
      classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText: message })
        .forbidReason,
    ).toBe('financial_commit');
  });
});

describe('classifyAoiBrowserDriveAction - rentals, top-ups, trials and stops from the round-20 sweeps', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('refuses a rental named with its format, a trial moved onto and a top-up', () => {
    for (const message of [
      'Rent Dune (HD) - $3.99?',
      'Add $20 to your PayPal balance?',
      'Load $50 onto your transit card?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    expect(click('Rent Dune (HD)').forbidReason).toBe('financial_commit');
    expect(click('Rent apartments in SD').category).toBe('act');
  });

  it('lets a card limit, a payment no longer made and a plan kept through', () => {
    for (const message of [
      'Add $500 to your credit card limit?',
      'You will no longer pay $9.99/month. Continue?',
      "Cancel Premium? You'll stay subscribed until March 3 ($9.99/month).",
      "Your Premium plan will be cancelled. You'll keep Premium until March 3 ($9.99/month).",
      'Your $49.00 charge will stop. Continue?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
    for (const message of [
      "You'll no longer pay $4.99 for Basic but $14.99/month for Pro. Continue?",
      'Stay on Premium for $4.99/month?',
      'You were charged $49.00 last month. Pay $49.00 now?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

// Round 20 addendum: an account topped up, and money moved between accounts.
describe('classifyAoiBrowserDriveAction - an account topped up and money moved to savings', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('refuses an amount added to an account, and lets a limit, a goal or a cart through', () => {
    for (const message of [
      'Add $50 to your account?',
      'Add $50 to your PayPal account?',
      'Add $25 to your Steam account?',
      'Add $49.00 to your checking account?',
      'Add $49.00 to Checking account?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const message of [
      'Add $500 to your credit card limit?',
      'Add $500 to your account limit?',
      'Add $20 to your savings goal?',
      'Add $10 to your cart?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('refuses an amount moved to or into an account, and lets items moved through', () => {
    for (const message of [
      'Move $49.00 to Savings?',
      'Move $200 into your savings account?',
      'Move $49.00 from Checking to Savings?',
      'Move money of $49.00 to Savings?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const targetText of ['Move $49.00 to Savings', 'Move $49.00 from Checking to Savings']) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
    for (const message of [
      'Move 3 items to your cart?',
      'Move this item to your wishlist?',
      'Move the $49.00 item to your wishlist?',
      'Move 3 transactions ($149.00) to Groceries?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
    expect(click('Move to Savings').category).toBe('act');
  });
});

// Round 21: a told stop that keeps its mark, refund totals taken out by
// clause, "no longer pay" and other negated clauses ended at "and", a resend
// beside a repeat, a time a new price stands until, a phone head beside a code
// box, refunds told with "only", CJK Cancel windows across a pay page or a
// date and a press not made, 주문 완료 told as done, common pay wordings and
// full-width digits, a past payment given back, and an account by its number.
describe('classifyAoiBrowserDriveAction - a told stop keeps the mark that ended it', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a total in the sentence after charges that stop, or after "and"', () => {
    for (const message of [
      'Your installment charges will end. Amount due today: $349.00. Continue?',
      'Your monthly donation charges will stop. Donation amount: $100.00 (one-time). Continue?',
      'Your monthly charges will end today. Total due today: $99.00. Continue?',
      'Billing will stop. Total due today: $99.00. Continue?',
      'Charges will cease. Total: $99.00. Continue?',
      'Your trial charges will end today and your total of $49.00 is due now.',
      'Your monthly charges will stop. お支払い金額：4,900円。よろしいですか？',
      'Your monthly charges will stop. 支付金额：¥49.00。确定继续吗？',
      'Your monthly charges will end? Total due today: $99.00.',
      "Your plan will be cancelled and you won't be charged. Total due today: $99.00. Continue?",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets charges that stop through on their own', () => {
    for (const message of [
      'Cancel Premium? Your $9.99/month charge will stop at the end of the period.',
      'Your $9.99/month charge will stop. Continue?',
      'Your charges will stop and your plan will end on March 3. Continue?',
      'Your monthly charges will end on March 3. Continue?',
      'Cancel your plan? Your charges will stop. Total due today: $0.00.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a refund total taken out by its clause', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses the amount due a refund total shares its sentence with', () => {
    for (const message of [
      'Return 1 item and exchange for size M? Refund total: $49.00, exchange total: $59.00, amount due: $10.00.',
      '교환하시겠습니까? 환불 금액 39,000원, 추가 결제 금액 10,000원',
      '返金金額：1,000円、お支払い金額：4,900円。よろしいですか？',
      '退款金额：¥10.00，支付金额：¥49.00。确定继续吗？',
      'Refund total: $10.00 and amount due today: $39.00. Continue?',
      'Total refund $10.00 - total due $39.00. Continue?',
      'Refund total $10.00 / Payment amount $39.00. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a refund total through, alone in its clause or not', () => {
    for (const message of [
      '주문이 취소됩니다. 환불 합계는 49,000원입니다. 계속하시겠습니까?',
      'ご注文はキャンセルされます。返金合計は4,900円です。よろしいですか？',
      '订单将被取消。退款总额为¥49.00。确定继续吗？',
      'Refund total: $49.00. Continue?',
      'Your order will be cancelled. Order total: $49.00, which will be refunded to your card. Continue?',
      'Order total: $49.00, which will be refunded to your card. Continue?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a negated clause ended at "and" before a new price', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a new price told after "no longer pay" or another negation and "and"', () => {
    for (const message of [
      "You'll no longer pay $9.99/month for Basic, and Pro will cost $14.99/month starting today. Continue?",
      'You will no longer pay $9.99/month for Basic and Pro costs $14.99/month from today. Continue?',
      "You'll no longer pay for Basic, and your new Pro plan costs $14.99/month. Continue?",
      "You won't be charged $9.99/month for Basic, and your new Pro plan costs $14.99/month. Continue?",
      'You will no longer be charged $9.99/month for Basic and Pro costs $14.99/month from today. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a payment no longer made through, and one already made', () => {
    for (const message of [
      'You will no longer pay $9.99/month. Continue?',
      "You won't be charged your next payment of $9.99. Continue?",
      "Downgrade to the free plan? You'll no longer pay $9.99/month and you'll keep your playlists.",
      "Cancel your plan? You won't be charged again and your last charge of $9.99 was on March 3.",
      'You will no longer be charged $9.99/month and your plan ($9.99/month) stays active until March 3.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a receipt resent beside a repeat', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a repeat whose message also sends a receipt', () => {
    for (const message of [
      'Repeat last payment: $49.00 to Acme Inc.? We will send a receipt to your email.',
      'Previous payment: $49.00 to Jane Doe. Repeat it? We will send the receipt by email.',
      'Last order: $49.00. Order again? We will send the confirmation to your inbox.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a receipt resent for a past payment through', () => {
    for (const message of [
      'Last payment: $49.00 on March 3. Resend receipt?',
      'Last payment: $49.00 on March 3. Send the receipt again?',
      'Previous payment: $49.00. Resend the confirmation email?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a time a price stands until, beside the plan kept', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a new plan priced until the end of a term or a date', () => {
    for (const message of [
      'Cancel Basic? Your free Pro trial starts today. After that, Pro is $14.99/month until the end of your contract.',
      'Cancel Basic? Your free Pro trial starts today. After that, Pro is $14.99/month until March 3, 2027.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets the plan kept until then through', () => {
    for (const message of [
      'Cancel your membership? Your free account will be activated on March 3. Premium ($9.99/month) stays active until then.',
      "Cancel your Premium plan? Your free plan starts on March 3. You'll keep Premium ($9.99/month) until then.",
      'Cancel Premium? Your Free plan will start on March 3. Premium is $9.99/month until then.',
      'Cancel Premium? Your Free plan will start on March 3. Premium stays active until March 3 ($9.99/month).',
      'プレミアムを解約しますか？解約後は無料プランに移行します。プレミアム（月額980円）は3月3日までご利用いただけます。',
      '프리미엄을 해지하시겠습니까? 해지 후 무료 요금제로 변경됩니다. 프리미엄(월 9,900원)은 3월 3일까지 이용할 수 있습니다.',
      '要取消会员吗？取消后将改用免费版。会员（每月¥15）可使用至3月3日。',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a phone head beside a code box', () => {
  const typeInto = (field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field });
  const setUp = 'Set up 2-Step Verification';
  const group = '2-Step Verification';

  it('refuses a box whose other words ask for the code', () => {
    const fields: AoiBrowserDriveActionField[] = [
      { label: 'Phone number ending in 34', placeholder: 'Code', group },
      { name: 'phone', placeholder: 'Enter code', group: setUp },
      { id: 'phone', placeholder: 'Enter code', group: setUp },
      { label: 'Mobile', placeholder: 'Enter code', group: setUp },
      { label: 'Email', placeholder: 'Enter code', group: setUp },
      { label: 'Phone', placeholder: '123456', group: setUp },
      { ariaLabel: 'Phone number', placeholder: 'Enter the 6 digits', group: setUp },
      { label: 'Phone number ending in 34 - enter the code we sent', group },
    ];
    for (const field of fields) {
      expect(typeInto(field).forbidReason, JSON.stringify(field)).toBe('sensitive_field');
    }
  });

  it('still lets a phone number, an email address or a number shown through', () => {
    const fields: AoiBrowserDriveActionField[] = [
      {
        label: 'Mobile number',
        type: 'tel',
        placeholder: 'Enter 10-digit mobile number',
        group: setUp,
      },
      { label: "Mobile number – we'll text you a code", type: 'tel', group: setUp },
      { label: 'Phone number to receive codes', type: 'tel', group: setUp },
      { type: 'tel', placeholder: '(555) 555-5555', group: setUp },
      { type: 'tel', id: 'phone', label: 'Where should we send your codes?', group },
      { type: 'email', label: 'Email address to send codes to', group },
      { label: 'Phone number', name: 'country_code', group },
      { label: 'Phone number ending in 34', group },
    ];
    for (const field of fields) {
      expect(typeInto(field).category, JSON.stringify(field)).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a refund told with "only"', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a payment refunded only once or only to a card through', () => {
    for (const message of [
      'Return this item? Your payment of $49.00 will only be refunded once we receive it.',
      'Return this item? Your payment of $49.00 can only be refunded to the original card.',
      'Payment of $49.00 refunded. View details?',
      'Your payment of $49.00 was successfully refunded. View receipt?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses a payment that cannot be called off, or another thing called off', () => {
    for (const message of [
      'Your payment of $49.00 cannot be cancelled. Continue?',
      'Your payment of $49.00 can only be cancelled within 24 hours. Continue?',
      'Your payment of $49.00 cannot be voided after today. Continue?',
      'Your payment of $49.00 is scheduled for today unless cancelled. Continue?',
      'Your payment of $49.00 cannot be refunded. Continue?',
      'Your payment of $49.00 for the cancelled booking is still due.',
      'Your payment of $49.00 for the returned item will be sent now. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - the CJK Cancel words across a pay page', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('lets a Cancel button that goes back to a pay page or a list through', () => {
    for (const message of [
      '배송지를 변경하시겠습니까? 구매 목록으로 돌아가려면 취소를 누르세요.',
      'クーポンを使用しますか？お支払い画面に戻る場合は「キャンセル」を押してください。',
      '确定使用优惠券吗？返回支付页面请点“取消”。',
      '결제 수단을 변경하시겠습니까? 결제 페이지로 돌아가려면 취소를 누르세요.',
      '配送先を変更しますか？購入画面に戻る場合は「キャンセル」を押してください。',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses what OK pays, and a button that goes to a pay page', () => {
    for (const message of [
      '확인 버튼을 누르면 49,000원이 결제되며 취소 버튼을 누르면 결제가 취소됩니다.',
      '4,900円をお支払いいただきます キャンセルを押すと戻ります',
      'お支払い画面に進むと4,900円が請求されます 戻る場合は「キャンセル」を押してください',
      '결제 페이지로 이동하면 결제가 진행되며 취소를 누르면 돌아갑니다',
      '支付页面将扣款¥49.00返回请点取消',
      '구매 목록의 상품을 구매하려면 확인을, 돌아가려면 취소를 누르세요',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const targetText of ['결제 페이지로 이동', '購入画面へ', '구매 목록']) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - the CJK Cancel words across a date, and a press not made', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a Cancel button whose words name a date through', () => {
    for (const message of [
      '要取消订阅吗？点击取消将保留订阅并在3月3日扣费¥15.00。',
      '구독을 해지하시겠습니까? 취소를 누르면 구독이 유지되고 그렇지 않으면 3월 3일에 해지됩니다.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('refuses what happens when Cancel is not pressed, and an amount after Cancel', () => {
    for (const message of [
      '「キャンセル」を押さないと980円が請求されます。',
      '취소를 누르지 않으면 결제가 진행됩니다.',
      '취소를 누르지 않으면 자동으로 결제됩니다.',
      'キャンセルを押さないと決済が完了します。',
      '不点击取消将完成支付。',
      '취소 버튼을 누르면 돌아가고 49000원이 결제됩니다.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('refuses what "otherwise" or another quoted button does after Cancel', () => {
    for (const message of [
      '点击取消返回否则将完成支付',
      "취소를 누르면 돌아가고 '예'를 누르면 결제됩니다.",
      '취소를 누르면 돌아가고 그렇지 않으면 결제됩니다.',
      '「キャンセル」を押すと戻り「続ける」を押すと決済されます。',
      '点击“取消”返回 点击“继续”完成支付',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - 주문 완료 told as done', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('lets an order told as completed through', () => {
    for (const message of [
      '주문이 완료되어 배송을 준비하고 있습니다. 주문 내역을 확인하시겠습니까?',
      '주문이 완료된 상품입니다. 리뷰를 작성하시겠습니까?',
      '주문이 완료돼 상품을 준비 중입니다. 확인하시겠습니까?',
      '주문을 완료한 고객님께 쿠폰을 드립니다. 쿠폰을 받으시겠습니까?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses an order completed by accepting', () => {
    for (const message of [
      '확인을 누르면 주문이 완료되고 취소를 누르면 장바구니로 돌아갑니다.',
      '주문을 완료하시겠습니까?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const targetText of ['주문 완료', '주문완료하기']) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - common pay wordings and full-width digits', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('refuses buttons that proceed with a payment, recharge or order for an amount', () => {
    for (const targetText of [
      'Proceed with payment',
      'Continue with payment',
      'Proceed with $49.00 payment',
      'Recharge ₹199',
      'Recharge now',
      'Recharge for ₹239',
      'Proceed to recharge',
      'Order for $49.00',
      'Order 2 for $49.00',
      'Send ＄２５.００',
      'Tip ￥５００',
    ]) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });

  it('refuses confirms of a payment, an amount due, a Korean total and full-width amounts', () => {
    for (const message of [
      'Proceed with your $49.00 payment?',
      'Continue with your $49.00 payment?',
      'Due today: $49.00. Continue?',
      'Due now: $49.00. Continue?',
      'You were charged $9.99 last month. $49.00 is due today.',
      '$49.00 is due now. Continue?',
      'Your payment of $49.00 for the cancelled booking is still due.',
      '총 49,000원입니다. 계속하시겠습니까?',
      '合計：４，９００円。よろしいですか？',
      'お支払い金額：４，９００円。よろしいですか？',
      '총 결제 금액: ４９，０００원. 계속하시겠습니까?',
      '支付金额：￥４９．００。确定继续吗？',
      'Total: ＄４９.００. Continue?',
      'Recharge ₹199 for 9876543210?',
      'Order 2 items for $49.00?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a way to pay, a battery, a list or a refund due through', () => {
    for (const targetText of [
      'Proceed to shipping',
      'Continue with payment options',
      'Recharge your batteries',
      'Recharge',
      'Order history',
      'Order for $49.00 or more to get free shipping',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
    for (const message of [
      'A refund of $49.00 is due today. Continue?',
      '총 3개의 상품을 삭제하시겠습니까?',
      'Cancel this item? Your order for $49.00 will be updated.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a past payment given back', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a cancel through that names what was paid and gives it back', () => {
    for (const message of [
      '예약을 취소하시겠습니까? 결제하신 49,000원은 3일 이내에 환불됩니다.',
      '确定取消订单吗？已支付的¥49.00将原路退回。',
      '주문을 취소하시겠습니까? 결제한 49,000원은 환불됩니다.',
      'キャンセルしますか？支払った4,900円は返金されます。',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses a total with a particle, a payment still to be made and a new one', () => {
    for (const message of [
      'お支払い金額は4,900円です。よろしいですか？',
      '결제 금액은 49,000원입니다. 계속하시겠습니까?',
      '支付金额为¥49.00。确定继续吗？',
      '付款金额是¥49.00，确定吗？',
      '결제하신 후에는 취소할 수 없습니다. 계속하시겠습니까?',
      '결제하신 49,000원은 환불되지 않으며 추가로 9,900원이 결제됩니다. 계속하시겠습니까?',
      '결제한 금액 49,000원은 환불되지 않습니다. 계속하시겠습니까?',
      '支払った4,900円は返金できません。よろしいですか？',
      '已支付的¥49.00不予退款，确定继续吗？',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - an account topped up by its number', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses an amount added to an account named by its number, not a limit', () => {
    expect(accept('Add $50.00 to your account number ending 1234?').forbidReason).toBe(
      'financial_commit',
    );
    expect(accept('Add $500 to your credit card limit?').category).toBe('act');
  });
});

// Round 21 addendum: an amount confirmed, approved or authorized, a bet or a
// wager with its amount, a count of items with its amount as a total line,
// and 消费 with an amount.
describe('classifyAoiBrowserDriveAction - an amount confirmed, approved or authorized', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('refuses a confirm that names an amount with confirm, approve or authorize', () => {
    for (const message of [
      'Confirm $49.00?',
      'Approve the $49.00 transaction?',
      'Approve $49.00 payment to Acme?',
      'Authorize a $49.00 charge?',
      'Confirm the $500.00 transfer?',
      'Confirm 49,000원?',
      'Confirm $49',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a confirm of no amount, a refund, a cancellation or a denial through', () => {
    for (const message of [
      'Confirm your email address?',
      'Approve this request?',
      'Confirm 2 items?',
      'Confirm cancellation of your $9.99/month plan?',
      'Confirm the $49.00 refund?',
      'Approve $49.00 expense report?',
      'We did not approve $49.00.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
    for (const targetText of ['Confirm $49.00', 'Approve $49.00']) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a bet or a wager with its amount', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('refuses a bet or a wager made with its amount', () => {
    for (const message of [
      'Bet $10.00 on Team A?',
      'Place a $10 bet on Team A?',
      'Wager $25.00?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const targetText of ['Bet $10', 'Place $10 bet', 'Wager $25']) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });

  it('still lets words that only hold "bet" through', () => {
    for (const targetText of ['Best $10 deals', 'Alphabet $10 blocks']) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a count of items with its amount as a total line', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a count of items set beside its amount', () => {
    for (const message of ['2 items - $49.00. Proceed?', '3 items · $49.00. Continue?']) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a removal, a count alone and an item added to a cart through', () => {
    for (const message of [
      '2 items removed. Continue?',
      'Remove 2 items ($49.00)?',
      'Remove from cart? 2 items - $49.00',
      'Add to cart? 1 item, $49.00',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - 消费 with an amount', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('refuses a spend named with its amount', () => {
    for (const message of ['本次消费¥49.00，确定吗？', '消费金额：¥49.00']) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a list of spending through', () => {
    for (const text of ['消费记录', '查看消费明细']) {
      expect(accept(text).category, text).toBe('act');
      expect(click(text).category, text).toBe('act');
    }
  });
});

// Round 22: 주문 완료 told as what accepting does, a "but" after a payment no
// longer made, a charge going away after a negated clause's "and", 총 beside a
// discount, returns that list what was paid and amounts due beside a stop, a
// stopped plan's own price, phone fields told as digits, plans kept until a
// date, orders named for an amount, CJK pay verbs, English charges and order
// summaries.
describe('classifyAoiBrowserDriveAction - 주문 완료 told as what accepting does', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses an order completed by accepting, whatever its ending', () => {
    for (const message of [
      '확인을 누르면 주문이 완료되어 취소할 수 없습니다. 계속하시겠습니까?',
      '주문이 완료된 후에는 취소할 수 없습니다. 진행하시겠습니까?',
      '주문을 완료한 후에는 변경할 수 없습니다. 계속 진행하시겠습니까?',
      '확인을 누르면 주문이 완료되어 상품이 발송됩니다.',
      '확인을 누르시면 주문이 완료돼요. 계속할까요?',
      '주문 완료된 건은 취소가 불가합니다. 계속하시겠습니까?',
      '확인을 누르시면 주문이 완료된 것으로 처리됩니다.',
      '주문이 완료되어도 괜찮으시겠습니까?',
      '확인을 누르면 주문이 완료되어 배송이 시작될 수 있습니다.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets an order told as a completed state through', () => {
    for (const message of [
      '주문이 완료되어 배송을 준비하고 있습니다. 주문 내역을 확인하시겠습니까?',
      '주문이 완료된 상품입니다. 리뷰를 작성하시겠습니까?',
      '주문이 완료돼 상품을 준비 중입니다. 확인하시겠습니까?',
      '주문을 완료한 고객님께 쿠폰을 드립니다. 쿠폰을 받으시겠습니까?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a "but" after a payment no longer made or charges that stop', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses the amount still due after the "but"', () => {
    for (const message of [
      "Cancel your plan? You'll no longer pay $9.99/month, but $49.00 is due today to end your contract early.",
      "Cancel your contract? You'll no longer pay the monthly fee, but the remaining $199.00 is due today.",
      'Cancel your plan? Your monthly charges will stop, but $49.00 is due today.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a payment no longer made through', () => {
    for (const message of [
      'You will no longer pay $9.99/month. Continue?',
      "Downgrade to the free plan? You'll no longer pay $9.99/month and you'll keep your playlists.",
      "Cancel Premium? You'll no longer pay $9.99/month, but you keep Premium until March 3.",
      'Cancel your subscription? Your charges will stop, but your plan stays active until March 3.',
      "You won't be charged. Only $49.00 at delivery.",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a charge going away after a negated clause', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a cancel through whose charge is told as reversed, cancelled or refunded', () => {
    for (const message of [
      "Cancel your order? You won't be charged and the $49.00 charge will be reversed within 3 days.",
      "Cancel Premium? You won't be charged again and your upcoming charge of $9.99 has been cancelled.",
      "Cancel this booking? You won't be charged, and the $120.00 fee you paid will be refunded.",
      "Turn off auto-renew? You won't be charged on March 3, and the $99.00 annual fee will not apply.",
      "Cancel your trial? You won't be charged and the $14.99/month charge will never start.",
      'Your charges will stop and your upcoming charge of $9.99 has been cancelled. Continue?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses a charge that resumes or applies, and a payment after the charge gone', () => {
    for (const message of [
      "Pause your membership? You won't be charged during the pause and your $9.99/month fee resumes on April 1.",
      "You won't be charged $9.99/month for Basic, and your new Pro plan costs $14.99/month. Continue?",
      "You won't be charged today, and a $49.00 charge applies. Continue?",
      "You won't be charged and the $49.00 charge will be reversed, and Pro ($14.99/month) starts today. Continue?",
      "Cancel your plan? You won't be charged and the $49.00 charge will be reversed once we charge $59.00.",
      'Your plan will be cancelled and your order of $49.00 will be placed. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - 총 beside a discount, an accrual or a refund', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets an amount a discount, an accrual or a refund names through', () => {
    for (const message of [
      '쿠폰을 적용하시겠습니까? 총 5,000원이 할인됩니다.',
      '리뷰를 등록하시겠습니까? 총 500원이 적립됩니다.',
      '반품 신청하시겠습니까? 환불 예정 금액은 총 49,000원입니다.',
      '선택한 쿠폰 2장을 사용하시겠습니까? 총 3,000원 할인',
      '确定导出消费记录吗？本月消费¥1,234.00',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses a total paid, after a discount or beside one', () => {
    for (const message of [
      '총 49,000원입니다. 계속하시겠습니까?',
      '총 49,000원이 결제됩니다.',
      '할인 후 총 44,000원입니다. 계속하시겠습니까?',
      '총 49,000원, 할인 5,000원. 계속하시겠습니까?',
      '本次消费¥49.00，确定吗？',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a return that lists what was paid, and an amount due beside a stop', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a return through that states what was paid beside the refund', () => {
    for (const message of [
      'Return this item? Order total: $52.00, refund total: $49.00.',
      '반품하시겠습니까? 결제 금액: 52,000원, 환불 금액: 49,000원',
      '返品しますか？お支払い金額：5,200円、返金金額：4,900円',
      '确定退货吗？实付金额：¥52.00，退款金额：¥49.00',
      '반품 신청하시겠습니까? 총 결제 금액 52,000원 / 환불 예정 금액 49,000원',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('refuses an amount due, a fee charged, an exchange and a payment beside the return', () => {
    for (const message of [
      'Cancel your contract early? Total due today: $199.00.',
      'Cancel your plan? Early termination: $49.00 due today.',
      'Return this item? A $5.99 return shipping fee will be charged.',
      'Return this item? Amount due today: $5.99.',
      'Return 1 item and exchange for size M? Refund total: $49.00, exchange total: $59.00, amount due: $10.00.',
      '교환하시겠습니까? 환불 금액 39,000원, 추가 결제 금액 10,000원',
      'Return this item? 결제 금액: 52,000원, 환불 금액: 49,000원 Amount due: $10.00.',
      'Return this item? Order total: $52.00, refund total: $49.00, your $59.00 order ships today.',
      'Total due today: $10.00 and $49.00 is refunded. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets an amount of nothing or a refund due through', () => {
    for (const message of [
      'Cancel your plan? Amount due today: $0.00.',
      'Cancel your order? A refund of $49.00 is due today.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a stopped plan told with its price as ending', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets charges that stop beside the plan that ends through', () => {
    for (const message of [
      'Your charges will stop and your Premium plan ($9.99/month) ends on March 3. Continue?',
      'Your monthly charges will end and your $9.99/month membership expires on March 3. Continue?',
      'Billing will stop and your subscription ($9.99/month) ends after this period. Continue?',
      'Your charges will stop and Premium ($9.99/month) ends March 3. Are you sure?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses another price beside it, and a total after a stop', () => {
    for (const message of [
      'Your charges will stop and your Premium plan ($9.99/month) ends on March 3; $49.00 now. Continue?',
      'Your subscription ($9.99/month) ends on March 3, and your order of $49.00 will be placed. Continue?',
      'Your monthly charges will end today. Total due today: $99.00. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a phone field told as digits on a two-step page', () => {
  const typeInto = (field: AoiBrowserDriveActionField) =>
    classifyAoiBrowserDriveAction({ kind: 'type', selector: '#f', text: '1', field });
  const group = '2-Step Verification';

  it('lets a phone number told as so many digits through', () => {
    for (const field of [
      { label: 'Mobile number', type: 'tel', placeholder: '10 digits', group },
      { label: 'Mobile number', type: 'tel', placeholder: 'Digits only', group },
    ]) {
      expect(typeInto(field).category, JSON.stringify(field)).toBe('act');
    }
  });

  it('still refuses a code told by its length or its name', () => {
    for (const field of [
      { label: 'Mobile', placeholder: 'Enter the 6 digits', group },
      { label: 'Phone', placeholder: 'Code', group },
      { label: 'Phone', placeholder: 'Enter code', group },
    ]) {
      expect(typeInto(field).forbidReason, JSON.stringify(field)).toBe('sensitive_field');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a plan with its price kept until a date', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it("lets a free start through beside the plan that is the user's until a date", () => {
    for (const message of [
      'Cancel Premium? Your free plan will start on March 3. Premium ($9.99/month) is yours until March 3.',
      'Cancel Premium? Your free plan will start on March 3. Your Premium benefits ($9.99/month) last until March 3.',
      '프리미엄을 해지하시겠습니까? 3월 3일부터 무료 요금제로 변경됩니다. 프리미엄(월 9,900원)은 3월 3일까지입니다.',
      'プレミアムを解約しますか？3月3日から無料プランに移行します。プレミアム（月額980円）は3月3日までです。',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses a new plan priced until a date, or one that goes on after it', () => {
    for (const message of [
      'Cancel Basic? Your free Pro trial starts today. After that, Pro is $14.99/month until the end of your contract.',
      'Cancel Basic? Your free Pro trial starts today. Pro ($14.99/month) lasts until March 3, then renews.',
      'Cancel Basic? Your free Pro trial starts today. After that, Pro is yours until the end of your contract for $14.99/month.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe('classifyAoiBrowserDriveAction - an order named for an amount', () => {
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a link to an order already made or its number through', () => {
    for (const targetText of [
      'Track order for $49.00',
      'Gift order for $49.00 shipped to Jane',
      'Order 123 for $49.00 - Delivered',
      'Spend $50, get free shipping on your next order for $0',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });

  it('still refuses an order asked for with its amount', () => {
    for (const targetText of [
      'Order for $49.00',
      'Pre-order for $49.00',
      'Order 2 for $49.00',
      'Click to order 123 for $49.00',
    ]) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
    expect(accept('Do you want to order this item for $49.00?').forbidReason).toBe(
      'financial_commit',
    );
  });
});

describe('classifyAoiBrowserDriveAction - CJK pay verbs asked, and 共计', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('refuses a top-up, a gift of money, a donation or a send asked', () => {
    for (const message of [
      '10,000원을 충전하시겠습니까?',
      '홍길동님께 10,000원을 보내시겠습니까?',
      '홍길동님께 10,000원을 보낼까요?',
      '5,000원을 후원하시겠습니까?',
      '1,000円をチャージしますか？',
      '1,000円を寄付しますか？',
      '1,000円を送りますか？',
      '共计¥49.00，确定提交吗？',
      '10,000원이 충전됩니다. 계속하시겠습니까?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    for (const targetText of ['10,000원 충전', '1,000円チャージ']) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
  });

  it('still lets a history, a charger, a battery and a message through', () => {
    for (const targetText of [
      '충전 내역',
      'チャージ履歴',
      '충전기를 연결하세요',
      '배터리 충전 중',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
    for (const message of [
      'メッセージを送りますか？',
      '배터리를 충전하시겠습니까?',
      '10,000원 충전되었습니다. 확인하시겠습니까?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - English charges told actively, and order summaries', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });

  it('refuses a card charged, a charge authorized and an order summed up', () => {
    for (const message of [
      'OK to charge your card?',
      'Authorize this charge?',
      'This will charge your card ending in 4242. Continue?',
      "We'll charge your saved card now. OK?",
      'Order summary: 2 items, $49.00. Continue?',
      'Subtotal $45.00 + tax $4.00 = $49.00. Continue?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
    expect(click('Charge $49.00').forbidReason).toBe('financial_commit');
  });

  it('still lets a phone, a cable, a history and no charge through', () => {
    for (const message of [
      'Charge your phone before the update?',
      'No charge for this item. Continue?',
      "We won't charge your card until you confirm.",
      'Cancel your order? Order summary: 2 items, $49.00.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
    for (const targetText of ['Charging cable', 'Charge history', 'Why did we charge $49.00?']) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });
});

// Round 23: a charge told as not going away, or as going away only on a
// condition, after a negated clause, 총 beside a discount that is not the
// amount's own, a named order placed, reordered or scheduled, an order's
// number without its status, and a return for a different size.
describe('classifyAoiBrowserDriveAction - a charge told as not going away after a negated clause', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a fee told as not waived or not refunded', () => {
    for (const message of [
      'Cancel your contract? Your monthly charges will stop, and the early termination fee of $199.00 will not be waived.',
      'Cancel your contract? Your monthly charges will stop, and the early termination fee of $199.00 cannot be waived.',
      "Cancel your contract? Your monthly charges will stop, and the early termination fee of $199.00 can't be waived.",
      'Cancel your contract? Your monthly charges will stop, and the early termination fee of $199.00 can’t be waived.',
      'Cancel your contract? Your monthly charges will stop, and the early termination fee of $199.00 will not be refunded.',
      'Cancel your contract? Your monthly charges will stop, and the early termination fee of $199.00 cannot be refunded.',
      "Cancel your contract? Your monthly charges will stop, and the early termination fee of $199.00 won't be refunded.",
      'Cancel your contract? Your monthly charges will stop, and the early termination fee of $199.00 will never be refunded.',
      'Cancel your contract? Your monthly charges will stop, and the early termination fee of $199.00 will in no case be waived.',
      'Cancel your contract? Your monthly charges will stop, and the early termination fee of $199.00 will NOT be waived.',
      'Cancel your contract? Your monthly charges will stop while the early termination fee of $199.00 cannot be waived.',
      'Cancel your plan? You will no longer be billed monthly, and the cancellation fee of $49.00 will not be waived.',
      "Cancel your membership? You won't be charged again, and the cancellation fee of $49.00 cannot be waived.",
      "Cancel your plan? Billing will stop and the termination fee of $199.00 can't be waived.",
      "Cancel your contract? You won't be billed after today, and the early termination fee of $199.00 will not be refunded.",
      "Book this class? You won't be charged a booking fee, and the class fee of $25.00 cannot be refunded.",
      "Reserve this seat? You won't be charged a service fee, and the ticket fee of $49.00 cannot be refunded.",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a charge through that is reversed, refunded or never applies', () => {
    for (const message of [
      "Cancel your order? You won't be charged and the $49.00 charge will be reversed within 3 days.",
      "Cancel Premium? You won't be charged again and your upcoming charge of $9.99 has been cancelled.",
      "Cancel this booking? You won't be charged, and the $120.00 fee you paid will be refunded.",
      "Cancel subscription? You won't be billed again and the payment of $9.99 for this month will be refunded.",
      "Cancel your trial? You won't be charged and the $99.00 annual fee will not apply.",
      "Cancel your trial? You won't be charged and the $14.99/month charge will never start.",
      "Cancel your trial? You won't be charged and the $14.99/month charge won't renew.",
      "Cancel your trial? You won't be charged and the fee of $99.00 won't apply.",
      "Cancel your trial? You won't be charged and the fee of $99.00 for this year will never start.",
      'Cancel your contract? Your monthly charges will stop, and the fee of $199.00 noted on your bill will be refunded.',
      'Cancel your contract? Your monthly charges will stop, and the fee of $49.00 for November will be refunded.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('refuses a fee told as waived, refunded or reversed only on a condition', () => {
    const contract =
      'Cancel your contract? Your monthly charges will stop, and the early termination fee of $199.00 will be waived';
    for (const message of [
      `${contract} if you return the device within 30 days.`,
      `${contract} only if you return the device within 30 days.`,
      `${contract} unless you keep the device.`,
      `${contract} provided you return the device.`,
      `${contract} provided that you return the device.`,
      `${contract} as long as you return the device.`,
      `${contract} once you return the device.`,
      `${contract} when you return the device.`,
      `${contract} after you return the device.`,
      `${contract} until you return the device.`,
      `${contract} subject to the return of the device.`,
      `${contract}, but only IF you return the device.`,
      'Cancel your plan? Billing will stop and the $49.00 charge will be reversed if the device is returned.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a charge through that goes away without a condition', () => {
    for (const message of [
      "Cancel your order? You won't be charged and the $49.00 charge will be reversed within 3 days. If you have questions, contact us.",
      'Your charges will stop and your upcoming charge of $9.99 has been cancelled. Continue?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('refuses a charge that does not start or apply until a date or an act, or goes away thereafter', () => {
    for (const message of [
      "Cancel your trial? You won't be charged and the $14.99/month charge will not start until March 3.",
      "Cancel your trial? You won't be charged and the $14.99/month charge won't start until March 3.",
      "Cancel your trial? You won't be charged and the $99.00 annual fee will not apply until you upgrade.",
      "Cancel your order? You won't be charged and the $49.00 charge will be reversed thereafter.",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

describe("classifyAoiBrowserDriveAction - 총 beside a discount that is not the amount's own", () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a total whose discount is a note, a price, a benefit or comes after it', () => {
    for (const message of [
      '총 49,000원(할인 적용)입니다. 계속하시겠습니까?',
      '총 49,000원 (쿠폰 할인 적용) 입니다. 계속하시겠습니까?',
      '선택하신 상품 2개, 총 49,000원(할인가)입니다. 계속하시겠습니까?',
      '상품 2개 총 44,000원 할인가로 주문됩니다. 계속하시겠습니까?',
      '총 44,000원에 할인 혜택이 적용되었습니다. 계속 진행하시겠습니까?',
      '총 44,000원 할인 적용가입니다. 다음 단계로 진행할까요?',
      '할인가 총 44,000원입니다. 계속하시겠습니까?',
      '총 44,000원(적립금 사용) 계속하시겠습니까?',
      '최종 총 44,000원 · 할인 적용됨. 계속하시겠습니까?',
      '총 5,000원 할인 후 44,000원입니다. 계속하시겠습니까?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets an amount discounted, accrued or refunded through', () => {
    for (const message of [
      '쿠폰을 적용하시겠습니까? 총 5,000원이 할인됩니다.',
      '리뷰를 등록하시겠습니까? 총 500원이 적립됩니다.',
      '반품 신청하시겠습니까? 환불 예정 금액은 총 49,000원입니다.',
      '쿠폰을 적용하시겠습니까? 총 3,000원 할인',
      '리뷰를 등록하시겠습니까? 총 1,200원 적립 예정',
      '반품하시겠습니까? 환불 금액: 총 49,000원',
      '쿠폰을 적용하시겠습니까? 할인 금액은 총 5,000원입니다.',
      '쿠폰을 적용하시겠습니까? 총 5,000원을 할인해 드립니다.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a named order placed, and an order number without its status', () => {
  const click = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'click', selector: '#x', targetText });
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses a named order repeated, placed or confirmed, and an order count with its offer', () => {
    for (const targetText of [
      'Repeat last order for $23.50',
      'Repeat previous order for $23.50',
      'Repeat your last order for $23.50',
      'Repeat last order again for $23.50',
      'Place gift order for $49.00',
      'Place a gift order for $49.00',
      'Confirm next order for $49.00',
      'Submit your recent order for $49.00',
      'Complete past order for $49.00',
      'Finalise gift order for $49.00',
      'Finalize the gift order for $49.00',
      'Reorder last order for $23.50',
      'Reorder your last order for $23.50',
      'Schedule next order for $49.00',
      'Schedule your next order for $49.00',
      'Order 500 for $29.99 - Free shipping',
      'Order 250 for $19.99 · Save 20%',
      'Order 1000 for $99.00 | Best value',
    ]) {
      expect(click(targetText).forbidReason, targetText).toBe('financial_commit');
    }
    expect(accept('Order 500 for $29.99 - Free shipping. Continue?').forbidReason).toBe(
      'financial_commit',
    );
  });

  it('still lets an order named, tracked, viewed, cancelled or listed with its status through', () => {
    for (const targetText of [
      'Track order for $49.00',
      'View order for $49.00',
      'Cancel order for $49.00',
      'Your order for $49.00',
      'Gift order for $49.00 shipped to Jane',
      'Order for $49.00 or more',
      'Place your next order for $49.00 or more and save 10%',
      'Schedule next order for $49.00 or more',
      'Order 123 for $49.00 - Delivered',
      'Order 123 for $49.00 · Shipped',
      'Order 123 for $49.00 | Processing',
      'Order 123 for $49.00 - Out for delivery',
      'Order 12345 for $49.00 — In transit',
      'Order 123 for $49.00 - Cancelled',
      'Order 123 for $49.00 - Canceled',
      'Order 123 for $49.00 - Returned',
      'Order 123 for $49.00 - Refunded',
      'Order 123 for $49.00 - Completed',
      'Order 123 for $49.00 - Pending',
      'Order 123 for $49.00 - Paid',
    ]) {
      expect(click(targetText).category, targetText).toBe('act');
    }
  });
});

describe('classifyAoiBrowserDriveAction - a return for a different size is an exchange', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('refuses the totals of a return that gets a different size, colour or model', () => {
    for (const message of [
      'Return this item and get a different size? Refund total: $49.00, order total: $59.00.',
      'Return this item for another colour? Refund total: $49.00, order total: $59.00.',
      'Return this item and order a larger size? Refund total: $49.00, order total: $59.00.',
      'Return this item and choose a different model? Refund total: $49.00, order total: $59.00.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('still lets a return through that states what was paid beside the refund', () => {
    for (const message of [
      'Return this item? Order total: $52.00, refund total: $49.00.',
      'Return this item? Refund total: $49.00.',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });
});

// Round 24: a charge goes away only where nothing but a time span, the card or
// the account the money goes back to, or an adverb follows the word that tells
// it gone; and 총 is excused only where its discount, accrual or refund word is
// the amount's own predicate or ends its clause.
describe('classifyAoiBrowserDriveAction - what may follow a charge told as going away', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a charge through with only a time span, a card or an account, or an adverb after it', () => {
    for (const message of [
      "Cancel your order? You won't be charged and the $49.00 charge will be reversed within 3 days.",
      "Cancel Premium? You won't be charged again and your upcoming charge of $9.99 has been cancelled.",
      "Cancel this booking? You won't be charged, and the $120.00 fee you paid will be refunded.",
      'Cancel your plan? Your monthly charges will stop and the $99.00 annual fee will not apply.',
      "Cancel subscription? You won't be billed again and the payment of $9.99 for this month will be refunded.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to your original payment method.",
      "Cancel your order? You won't be charged and the $49.00 charge will be reversed in 5-7 business days.",
      "Cancel your order? You won't be charged and the $49.00 charge will be reversed in 5–7 working days.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to your original payment method within 5-7 business days.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded automatically.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded in full.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to the card on file.",
      "Cancel your order? You won't be charged and the $49.00 charge will be reversed within 24 hours",
      "Turn off auto-renew? You won't be charged again and your $99.00 annual fee won't renew.",
      "Cancel your order? You won't be charged and the $49.00 charge will be reversed within 3 to 5 business days.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to your credit card.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to the original debit card.",
      "Cancel your order? You won't be charged and the pending $49.00 charge will drop off your statement.",
      "Cancel your order? You won't be charged and the pending $49.00 charge will fall off your bill within 3 days.",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses those tails beside a condition, and a card, an account or a statement named another way', () => {
    for (const message of [
      "Cancel your order? You won't be charged and the pending $49.00 charge will drop off your statement if you return the device.",
      "Cancel your order? You won't be charged and the pending $49.00 charge will drop off your next statement.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded your statement.",
      "Cancel your order? You won't be charged and the $49.00 charge will be reversed within 3 to 5 business days if you return the device.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to your credit card unless you keep the device.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to the customer who returns it.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to your account if you return the device.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to your account once returned.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to your account\nif you return the device.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded as store credit.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to your very old bank account.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to your card ending in 42424.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded within eleven days.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded within a few days if you return the device.",
      "Cancel your order? You won't be charged and the $49.00 charge will be credited to your gift card.",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('lets a charge through refunded to a named card, account, balance or credit, or within a span told in words', () => {
    for (const message of [
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to your card ending in 4242.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to your bank account.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to your PayPal account.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to your original form of payment.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to your Apple ID balance.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to your gift card.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to your credit account.",
      "Cancel your order? You won't be charged and the $49.00 charge will be removed from your next bill.",
      "Cancel your order? You won't be charged and the $49.00 charge will be reversed on your next statement.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded back to your original method of payment.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded into your wallet.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to your credit card on file automatically.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to the card ending in 42 within 3 to 5 business days.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded within a few days.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded in a couple of business days.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded within the next 3 days.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded within two weeks.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded within the next few days.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded within three to five business days.",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('refuses a charge that goes away, or does not apply, only on a condition', () => {
    const contract =
      'Cancel your contract? Your monthly charges will stop, and the early termination fee of $199.00 will be waived';
    for (const message of [
      `${contract} upon return of your device.`,
      "Cancel your contract? Your monthly charges will stop, and the $199.00 early termination fee won't apply if you return your device within 30 days.",
      `${contract} should you return the device within 30 days.`,
      "Cancel your contract? You won't be billed after today, and the early termination fee of $199.00 will be waived providing you return the device.",
      `${contract} on return of your device.`,
      `${contract} with the return of your device.`,
      `${contract} in exchange for your old device.`,
      `${contract} so long as you return the device.`,
      `${contract} as soon as you return the device.`,
      `${contract} in case you return the device.`,
      `${contract} on condition that you return the device.`,
      `${contract} by returning the device within 30 days.`,
      `${contract} pending return of your device.`,
      `${contract} for customers who return their device.`,
      `${contract}\nif you return the device within 30 days.`,
      'Cancel your contract? Your monthly charges will stop, and the $199.00 early termination fee will not apply unless you keep the device.',
      'Cancel your contract? Your monthly charges will stop, and the $199.00 early termination fee does not apply when you return the device within 14 days.',
      "Cancel your plan? You won't be billed again, and the cancellation fee of $49.00 will not apply after your 12-month term.",
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('refuses a charge with a date, another clause, a part or a card it does not name after it', () => {
    for (const message of [
      "Start your trial? You won't be charged today and the $9.99/month fee will not start until March 3.",
      "Start your free trial? You won't be charged today, and your $9.99/month fee won't renew if you cancel before March 3.",
      "Cancel your order? You won't be charged and the $49.00 charge will be reversed and you'll get an email.",
      "Cancel your order? You won't be charged and the $49.00 charge will be refunded to the card you provided.",
      "Cancel your order? You won't be charged and the $49.00 charge will be reversed after 3-5 business days.",
      "Cancel your order? You won't be charged and the $49.00 charge will be reversed within 3 days\nOK?",
      'Cancel your contract? Your monthly charges will stop, and the $199.00 early termination fee will be waived in part.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('lets a condition in the next sentence through, a known limit', () => {
    const message =
      'Cancel your contract? Your monthly charges will stop, and the early termination fee of $199.00 will be waived. Return your device within 30 days to qualify.';
    expect(accept(message).category).toBe('act');
  });
});

describe("classifyAoiBrowserDriveAction - 총 excused only by the amount's own predicate", () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets an amount discounted, accrued or refunded through', () => {
    for (const message of [
      '쿠폰을 적용하시겠습니까? 총 5,000원이 할인됩니다.',
      '리뷰를 등록하시겠습니까? 총 500원이 적립됩니다.',
      '쿠폰을 적용하시겠습니까? 총 3,000원 할인',
      '리뷰를 등록하시겠습니까? 총 1,200원 적립 예정',
      '쿠폰을 적용하시겠습니까? 총 5,000원을 할인해 드립니다.',
      '반품 신청하시겠습니까? 환불 예정 금액은 총 49,000원입니다.',
      '주문을 취소하시겠습니까? 총 49,000원이 환불됩니다.',
      '쿠폰을 적용하시겠습니까? 총 5,000원 할인합니다.',
      '쿠폰을 적용하시겠습니까? 총 5,000원이 할인됐습니다.',
      '쿠폰을 적용하시겠습니까? 총 5,000원이 할인돼요.',
      '리뷰를 등록하시겠습니까? 총 500원 적립, 감사합니다.',
      '쿠폰 할인 총 44,000원입니다. 계속하시겠습니까?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('refuses a total whose discount, accrual or refund word is followed by anything else', () => {
    for (const message of [
      '총 49,000원 환불 불가입니다. 계속하시겠습니까?',
      '총 49,000원 할인 포함입니다. 계속하시겠습니까?',
      '총 49,000원 적립금 사용 완료. 계속하시겠습니까?',
      '총 44,000원 할인받고 진행하시겠습니까?',
      '총 49,000원이 할인되지 않습니다. 계속하시겠습니까?',
      '총 49,000원이 환불되지않습니다. 계속하시겠습니까?',
      '총 49,000원 할인 안 됩니다. 계속하시겠습니까?',
      '총 49,000원 할인이 안 됩니다. 계속하시겠습니까?',
      '총 5,000원 할인받으세요. 계속하시겠습니까?',
      '쿠폰을 받으시겠습니까? 총 5,000원 할인 쿠폰이 지급됩니다.',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

// Round 25: 총 before a refund, an accrual or a discount told in the future or
// as processed, a point before a digit that ends no sentence, card brands and
// card endings, a span of a day or a week, "as well" and "too", and no
// condition or negation among a destination's words.
describe('classifyAoiBrowserDriveAction - 총 told in the future or as processed, and a point before a digit', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });

  it('lets a refund, an accrual or a discount told as to come or processed through', () => {
    for (const message of [
      '반품을 신청하시겠습니까? 총 49,000원이 환불될 예정입니다.',
      '리뷰를 등록하시겠습니까? 총 500원이 적립될 예정입니다.',
      '쿠폰을 적용하시겠습니까? 총 5,000원이 할인될 예정입니다.',
      '환불 신청하시겠습니까? 총 49,000원이 환불 처리됩니다.',
      '환불 신청하시겠습니까? 총 49,000원이 환불 진행됩니다.',
      '환불 신청하시겠습니까? 총 49,000원이 환불 처리될 예정입니다.',
      '홍길동님께 총 50,000원이 지급될 예정입니다. 진행하시겠습니까?',
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses one that cannot come, is not processed, or is followed by a point and a digit', () => {
    for (const message of [
      '총 49,000원이 환불될 수 없습니다. 계속하시겠습니까?',
      '총 49,000원이 환불될 수가 없습니다. 계속하시겠습니까?',
      '총 49,000원이 환불 처리되지 않습니다. 계속하시겠습니까?',
      '총 49,000원이 환불 진행되지 않습니다. 계속하시겠습니까?',
      '총 49,000원 할인 진행 불가. 계속하시겠습니까?',
      '총 5,000원이 할인될 경우 44,000원이 결제됩니다. 계속하시겠습니까?',
      '총 49,000원 할인된 가격입니다. 계속하시겠습니까?',
      '총 44,000원 할인받고 진행하시겠습니까?',
      '총 49,000원 결제될 예정입니다. 계속하시겠습니까?',
      '총 49,000원이 청구될 예정입니다. 계속하시겠습니까?',
      '총 49,000원 할인.5 적용가입니다. 계속하시겠습니까?',
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('refuses a charge told as going away to a card ending in an amount, before a condition', () => {
    const message =
      'Cancel your contract? Your monthly charges will stop, and the early termination fee of $199.00 will be waived to your card ending in 42.00 if you keep the device.';
    expect(accept(message).forbidReason).toBe('financial_commit');
  });
});

describe('classifyAoiBrowserDriveAction - card brands and endings, a day or a week, as well and too', () => {
  const accept = (targetText: string) =>
    classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText });
  const order = "Cancel this order? You won't be charged, and the $49.00 charge will be refunded";

  it('lets a charge through refunded to a card by its brand or its ending, within a day or a week, as well or too', () => {
    for (const message of [
      `${order} to your Visa ending in 4242.`,
      `${order} to your Mastercard ending in 1234.`,
      `${order} to your Amex ending in 1005.`,
      `${order} to your American Express ending in 1005.`,
      `${order} to your Discover ending in 0005.`,
      `${order} to your card ending 4242.`,
      `${order} to your card ending with 4242.`,
      `${order} to your card ending in ****4242.`,
      `${order} to your card ending in •••• 4242.`,
      `${order} within a week.`,
      `${order} within a day.`,
      `${order} in an hour.`,
      `${order} within a business day.`,
      "Cancel your order? You won't be charged and the $49.00 charge will be reversed as well.",
      "Cancel your order? You won't be charged and the $49.00 charge will be reversed too.",
      "Cancel your subscription? You won't be billed again, and your upcoming $9.99 charge will be cancelled too.",
    ]) {
      expect(accept(message).category, message).toBe('act');
    }
  });

  it('still refuses those tails beside a condition, a card named without its ending, and other destinations', () => {
    const contract =
      'Cancel your contract? Your monthly charges will stop, and the early termination fee of $199.00 will be waived';
    for (const message of [
      `${contract} to your Visa ending in 4242 if you keep the device.`,
      `${contract} as well, provided you return the device.`,
      `${contract} too if you return the device.`,
      `${contract} to your card ending in ****4242 unless you keep the device.`,
      `${contract} within a week of your device return.`,
      "Cancel your order? You won't be charged and the $49.00 charge will be reversed to your Visa •••• 4242.",
      `${order} to your PayPal.`,
      `${order} to your bank.`,
      `${order} depending on your bank.`,
      `${order} as store credit.`,
      `${order} to you.`,
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });

  it('refuses a destination with a condition or a negation among its words', () => {
    for (const message of [
      `${order} to your if eligible account.`,
      `${order} to the once-used card.`,
      `${order} to the after-hours account.`,
      `${order} to your subject to card.`,
      `${order} to your never-expiring card.`,
    ]) {
      expect(accept(message).forbidReason, message).toBe('financial_commit');
    }
  });
});

// A page writes its own dialogs and labels: no length of its words may cost
// more than reading them, whatever they repeat.
describe('classifyAoiBrowserDriveAction - long page-written text', () => {
  it('judges a 50,000-character message in a bounded time on every route', () => {
    const fill = (unit: string) => unit.repeat(Math.ceil(50_000 / unit.length)).slice(0, 50_000);
    const routes = [
      (text: string) => classifyAoiBrowserDriveAction({ kind: 'click', targetText: text }),
      (text: string) =>
        classifyAoiBrowserDriveAction({ kind: 'dialog', disposition: 'accept', targetText: text }),
      (text: string) =>
        classifyAoiBrowserDriveAction({
          kind: 'dialog',
          disposition: 'accept',
          promptText: '1',
          targetText: text,
        }),
      (text: string) =>
        classifyAoiBrowserDriveAction({
          kind: 'type',
          text: '1',
          field: { label: text, near: text },
        }),
      (text: string) =>
        classifyAoiBrowserDriveAction({
          kind: 'type',
          text: '1',
          field: { label: text, group: text, near: text },
        }),
      // A name and an id are read as written too (camelCase SSN and SIN).
      (text: string) =>
        classifyAoiBrowserDriveAction({ kind: 'type', text: '1', field: { name: text, id: text } }),
    ];
    for (const unit of [
      '$1',
      '1',
      ' ',
      '청구',
      '年费',
      'bill ' + '1'.repeat(40) + ' ',
      "won't be ",
      'not ',
      'check out ',
      'passport ',
      '拖动滑块',
      // A negated phrase, and its clause running on or stopped at every turn.
      "won't be charged ",
      "won't be charged $1 ",
      "won't be charged but ",
      "won't be charged yet ",
      'not be billed - ',
      'not be billed -',
      'never be renewed; ',
      '청구되지 않',
      '不会再扣费，',
      // "Check out" before a separator, an amount or an arrow.
      'check out - ',
      'check out ·$',
      'check out ▸',
      // Money sent, given, authorized; a payment, a donation, an offer, a total.
      'send ',
      'send x ',
      'send ' + 'x'.repeat(30) + ' ',
      'give us ',
      'bid us $',
      'authorize ',
      'approve payment ',
      'make a donation ',
      'submit an offer ',
      'convert now ',
      'total ',
      'total: ',
      'total due is ',
      'taken from your ',
      'donation of ',
      // A code named for what it is.
      'promo code we sent ',
      'gift card code sent to ',
      'code that was ',
      'email code ',
      // A stopping action, a reassurance, a priced action and a rate.
      'cancel ',
      'can cancel ',
      'cancel anytime ',
      'cancel or pause ',
      'remove ads for $',
      '$1/month ',
      '언제든지 해지',
      // An expiry beside other things that expire, and a payment.
      'expiry passport ',
      'expiry payment ',
      // A name written as on a document, and a document named elsewhere.
      'as written in their passport ',
      'name as on passport ',
      'passport/',
      'passport_name ',
      'names ',
      'number ',
      '身份证上的',
      // A sale refused, and one not.
      'not sell ',
      "don't sell ",
      // A stop and what it stops, a start, a price for the stopped time.
      'cancel your ',
      'cancel x ',
      'remove ' + 'x'.repeat(30) + ' ',
      'turn off auto-',
      'remove $9.99/',
      'cancel ? ',
      'stop 1.',
      'get ',
      'keep ',
      'keep your ',
      'go to ',
      'change to ',
      'stay on ',
      'can get ',
      'get anytime ',
      '변경',
      '切り替え',
      '升级',
      'while paused ',
      'while it is ',
      'during the pause ',
      // A verb and its amount where a control's words start, and what is not.
      '. give $',
      ': send x ',
      '• tip $1 ',
      '.',
      '|  ',
      'give $1 to a friend ',
      'give $1 to friends and ',
      'send me $',
      'send us $',
      'send a $5 off ',
      'give $1, get ',
      '\ngive $1',
      'schedule a payment reminder ',
      'submit offer for approval ',
      // Money taken, a total with its words, a rate, money sent.
      'taken out of your x ',
      'taken from my x y ',
      'total due today ',
      'total (',
      'total (incl. vat) ',
      'a month ',
      'each year $1 ',
      '월 ',
      '월1',
      '每月',
      '/月',
      '매월$1',
      'will be sent ',
      'is being paid $1 ',
      'gets collected ',
      // A negation's words, an until clause and the answer it names.
      "won't ever be ",
      'not yet been ',
      "don't forget ",
      "won't be charged until ",
      "won't be charged until you click ok ",
      "won't be charged until x, ",
      "won't be charged until pay $1 ",
      'until ok ',
      'click the "',
      // A code a message brought, and government numbers.
      "code we've ",
      'code is ',
      'check your email for a ',
      'check your phone for the 6-digit ',
      'social insurance ',
      'sin ',
      'national insurance ',
      'aadhaar',
      'pan card ',
      'tax file ',
      'tfn ',
      '证件号',
      '신분증 ',
      '免許証',
      // An expiry beside what a group buys.
      'expiry gift ',
      'expiry permit ',
      'expiration fee ',
      'expiry buy ',
      'expiry price ',
      // A start with its price, a value set, what a stop stops, a pause's price.
      'keep x ',
      'stay on x (',
      'go for $',
      'get a refund for $',
      'keep (',
      'move x x x x (',
      'get $1 back ',
      'change your budget to $',
      'change x ',
      'change your limit to $1 ',
      'cancellation ',
      'free cancellation ',
      'remove from cart ',
      '$1 while paused ',
      'while paused $1 ',
      '$1' + 'x'.repeat(29),
      // An amount sent, sending, spending, an order placed, a total's words.
      '$1 will be sent ',
      '$1/month x x will be paid ',
      '$1 x ',
      '$1 a month ',
      'spend $1 more ',
      'spending only $',
      'sending x ',
      'places your ',
      'total price cost payable ',
      // A negation's words, nothing charged, an until clause the clause keeps.
      'not going to be ',
      'nothing is ',
      'nothing will be charged ',
      "won't be charged until you click ok, ",
      "won't be billed until ok, x ",
      // A SIN, an SSN, Aadhaar, a code we sent, a date, a payment method, a dash.
      'sin ',
      'sin_',
      'sinnumber ',
      'x_sin ',
      'ssn',
      '_ssn',
      'with aadhaar ',
      'we sent a ',
      "we've just sent you the 6-digit ",
      'we sent a verification ',
      '3월 ',
      '월9',
      'approve payment methods ',
      '— give $1 ',
      '–',
      // A refund sent back, a stop and what it stops, a priced start in
      // brackets or in a reassurance, a value set, Aadhaar linked.
      'refund of $1 will be sent ',
      'credit $1 ',
      'cancel your purchase ',
      'cancel x x x payment ',
      'can get x for $1 ',
      'get x (only $1 ',
      'set your budget to $1 ',
      'with your aadhaar ',
      'aadhaar linked ',
      // A start in a sentence, a priced upgrade or account, a payment made, a
      // code's digits or message, a government number.
      'start x. ',
      'start $1. ',
      'upgrade x for $1 ',
      'create x for $1/month ',
      'make a payment ',
      'check out for $1 ',
      '6-digit code ',
      'code from the email ',
      'government id number ',
      'dl # ',
      'order of $1 ',
      'order ($1 ',
      'submit this $1 order ',
      // Round 15: a stop's window and the commit after it, a cancel of a named
      // plan, an amount's period, money sent back or refunded, a priced pause,
      // a bracketed amount, nothing charged except, an amount before until.
      'remove it and place order ',
      'remove x, ',
      'cancel x and ',
      'remove pay ',
      'cancel your plan and ',
      'cancel premium ',
      'stop renewing ',
      '$1.',
      '$49.00. x will be sent ',
      'refund $1 will be sent ',
      'a refund for the full $1 will be sent. ',
      '$1 will be sent back ',
      'sending your $1 refund ',
      'while paused: $1 ',
      '$1/month rate is locked while paused ',
      'costs $1 while paused. ',
      'move x ($1) ',
      'keep x ($1/month) ',
      'at $1/month ',
      'try x for $1 ',
      'continue with x (',
      'continue shopping for $1 ',
      'nothing is charged except $1 fee ',
      'nothing is charged until ok ',
      "won't be charged $1 until you click ok ",
      "won't be charged the $1 until ",
      // A verb and its amount on a control, more starts and rate words.
      'support us - give $1 ',
      ' - ',
      '👍🏽 tip $5 ',
      'add tip $1 ',
      'starts $1 ',
      'started ',
      '시작',
      '해지를 신청',
      '이용하시겠',
      '契約',
      '開始',
      '加入',
      '取消订阅',
      'weekly $1 ',
      '/wk',
      '/qtr',
      '/年',
      '每年',
      '毎年',
      '매년',
      '연 1',
      '2026년 ',
      'places your $1 order ',
      'placing x x $1 ',
      'debit $1 ',
      '$1 will be taken ',
      '$1 will be withdrawn ',
      // Fields: Aadhaar as written, a code that redeems, a PAN, names.
      'as per aadhaar ',
      'name on aadhaar ',
      'gift card 16-digit code ',
      'pan ',
      'abcde1234f',
      'code you received ',
      'ni number ',
      'employeeSsn',
      'make this payment recurring ',
      // Round 15 tuning: a passive cancel, an address as written, tips and
      // chips, a PAN in capitals, codes a message brought, SIN before a field
      // word, a new order, a cadence, stored money spent.
      'cancelled ',
      'canceled $1/month ',
      'address ',
      'address_line1 as per aadhaar ',
      'tip: ',
      'tip the x ',
      'tip: $',
      'chip in $',
      'add a $1 ',
      'leave a $1 tip ',
      'PAN ',
      'pan card ',
      'we emailed you a ',
      "we've texted you the ",
      'code sent via ',
      'sin - ',
      'sin required ',
      'sin (optional) ',
      'place a new ',
      'places a new order ',
      'finish your ',
      'every 2 weeks ',
      'every 99 ',
      'use $1 from your ',
      'apply $1 store ',
      'will be used for $1 ',
      'will be used for this $1 order ',
      // Round 16: a confirm's own Cancel button, a start told as what
      // accepting does, commit phrases with an amount or a kind, a credit
      // card, a code's digits, one-time code labels, a clause still charged,
      // currencies, asking words, start words, a priced start reassured, what
      // a stop stops in more scripts.
      'press cancel ',
      'click the "cancel" ',
      'or cancel to ',
      'or cancel ',
      'cancel to go back ',
      'cancel to ',
      'cancel returns you ',
      'cancel will take you ',
      'if you cancel, ',
      'if you cancel now ',
      'if you choose to cancel ',
      'will be upgraded ',
      'be upgraded to pro ',
      "you'll switch to ",
      'will switch you ',
      'will move you back to ',
      'will start today ',
      'will start losing ',
      'be renewed as ',
      'be renewed at $1 ',
      'be enrolled in ',
      'be subscribed to ',
      'be switched to the free ',
      'data will be moved to ',
      "won't be upgraded ",
      'make a $1 ',
      'make a $1/month one-time ',
      'confirm your $1 ',
      'submit $1 tip ',
      'make a one-time ',
      'send a gift ',
      'send a gift message ',
      'place an ',
      'approve a $1 ',
      '결제일',
      '決済日',
      '支払い済み',
      'credit card ',
      'credit $1 ',
      'credit card $1 will be sent ',
      'refund for the full $1 ',
      'refund of ',
      'refund: $1 ',
      'no refunds: $1 ',
      '$1 store credit will be sent ',
      '$1 credit ',
      'store credit is $1, so $1 will be paid ',
      '6-digit code ',
      '12-digit ',
      '16-digit code gift card ',
      '9-digit access code ',
      'we texted a confirmation ',
      'code in the ',
      'code in the email ',
      'code from google ',
      'code shown in x ',
      'code from your authenticator ',
      "won't be charged only ",
      "won't be charged x, plus ",
      "won't be billed just $1 ",
      'only ',
      'inr ',
      'cad 1',
      'aud 1 ',
      'rs.',
      'rs 1 ',
      'Rs.1',
      'users 5 ',
      'how to ',
      'how much to ',
      'how to tip $1 ',
      'should you ',
      'you should ',
      'why you should tip $1 ',
      '시작하지 않',
      '開始されません',
      '契約します',
      '契約は',
      '可随时重新订阅',
      'upgrade later ',
      'start again later ',
      'started today ',
      'begun x x x ',
      'restart anytime for $1 ',
      'rejoin for $1/month later ',
      'rejoin any time ',
      'take 3 months for $1 ',
      'select x for $1/month ',
      'choose x for $1 ',
      'pick x x ',
      'take a year ',
      'cancel this wire transfer ',
      'cancel the transfer transfer ',
      'plan plan ',
      '결제를 ',
      '결제를 취소',
      '注文を',
      '注文をキャンセル',
      '取消订单',
      '取消',
      '关闭自动续费',
      '关闭',
      '取り消',
      // Round 16 tuning: stops asked, named or told, totals, a clause still
      // charged, tips given, token codes, starts told, gifts, currency codes,
      // the Cancel button's clause, a denied price, headlines.
      'cancellation is free. ',
      'was cancelled ',
      'cancelling now will ',
      'cancel your plan. ',
      'cancel your x x plan ',
      '? cancel your plan. ',
      'will be cancelled ',
      'will no longer renew ',
      "won't renew ",
      'is going to be cancelled ',
      'plan will end ',
      'plan ($1) will end ',
      'item will be removed ',
      'if you cancel, you will lose ',
      'if you cancel your order, you will get ',
      'unsubscribe from ',
      'about to cancel ',
      'cancellation of your plan ',
      'turn off auto-renew ',
      '해지됩니다',
      '해지합니다',
      '解約されます',
      '解約します',
      '将被取消',
      '총 결제 금액: 1원',
      '합계 1원',
      '合計 1円',
      '总计 ¥1',
      'amount payable: $',
      'balance due: $1 ',
      'amount due today ',
      'amount to pay ',
      'payment amount ',
      'total is now $',
      'total will be $1 ',
      'balance: $1 ',
      "won't be charged; $1 ",
      "won't be charged – x ",
      "won't be charged - $",
      "won't be charged; x ",
      'with a $1 tip ',
      'with $1 ',
      'make an online payment ',
      'make a secure ',
      'thank x with a $1 tip',
      'tokencode ',
      'token code ',
      'we sent a text with a code ',
      'we sent you a text message with a ',
      'upgraded to ',
      '. upgraded to pro ',
      'upgrading you to ',
      'switched to paypal ',
      'be switched to your bank account ',
      'submit a tip ',
      'send a $1 gift ',
      'make a gift of $1 ',
      'gift of ',
      'cad 3d ',
      'cad 2024 drawing ',
      'usd 2000 to ',
      'cad 2024. ',
      'cny 2025 sale ',
      'or cancel to keep it ',
      'click cancel to cancel your order ',
      'cancel to go back to ',
      'no longer renew ($1/month) ',
      "won't renew ($1/month) ",
      'ways to give $1 ',
      'why i give $1 ',
      'how to pay $1 ',
      'how to donate $1 ',
      'when to buy ',
      // Round 17: the Cancel button's clause and the answers after it, a
      // stop speaking for its own sentence, a plan chosen, a move onto a free
      // tier, money paid with -ing or labelled, totals with a qualifier, more
      // starts, currencies, "but", kinds, codes, CJK cancels.
      'press cancel to go back or ok to pay ',
      'cancel to x or ',
      'or ok ',
      'ok or cancel. ',
      'proceed or cancel? ',
      'continue or cancel ',
      "total: $1. your pass won't renew. ",
      "won't renew. total: $1. ",
      'will end. ',
      '($1) ',
      'new total is $1. ',
      'you can rejoin later for $1. ',
      'cancel your order. $1. ',
      'select the annual plan for $',
      'pick the lifetime ',
      'choose x x x for $1 ',
      'take the plan plan ',
      'be switched to spotify free. ',
      'be moved to the basic plan (free). ',
      'switched to basic, which is free ',
      'moved to x x x x ',
      'be moved to premium (free for ',
      'you are paying $1 ',
      'buying x x x $',
      'giving away a $1 coupon ',
      'paying with ',
      'your payment: $1 ',
      'donation amount: $',
      'send now? ',
      '$1 to x. send now?',
      'invoice $1 send? ',
      'total incl. vat: €1 ',
      'total for 2 items: $',
      'total (x): $1 ',
      '合計（税込）：1円',
      '합계(부가세 포함): 1원',
      '바꾸',
      '乗り換え',
      '移行',
      '改用',
      '换成',
      'be activated ',
      'be put on ',
      'will renew today ',
      'renews now ',
      'eur 1999 incl. ',
      'kr ',
      '500 kr ',
      'r 1 ',
      'rm 1 ',
      'rp. 1 ',
      'zł ',
      '₺1',
      'r2-d2 ',
      "won't be charged, but $1 ",
      'make an extra $1 payment ',
      'give a gift of $',
      'how much to pay $1 ',
      '2-step verification ',
      '6-digit number we sent ',
      'code from your app ',
      '定期購入を停止',
      '关闭自动扣款',
      '取消自动扣费',
      '정기결제(월 1원)를 해지',
      // Round 18: the Cancel button's clause and the answers that end it, a
      // move onto a free plan priced after it, amounts of nothing, totals
      // with an excuse, "Send?", reported causes, holds, money subjects, free
      // plans activated, renewals turned off, CJK moves onto a free plan, the
      // Korean Cancel button, "but", past payments, R before a digit, two-step
      // fields, billing periods, refunded payments and CJK amount labels.
      'cancel to go back and remove items ',
      'or cancel to keep it and pay $1 ',
      'cancel to go back but ',
      ' or continue ',
      ' and click ',
      ' and confirm to ',
      ' then continue to ',
      'cancel to x or pay ',
      'press ok to confirm or cancel to go back and ',
      'be upgraded to pro with 1 month free, then $1 ',
      'be moved to basic ($0) ',
      'for $0 today ',
      '$0.00 ',
      '0원 ',
      'be switched to premium plus free shipping for $1 ',
      'total: $1 (taxes may apply). ',
      'will be removed. total due today: $1 (you can cancel anytime). ',
      'send? ',
      'send it? ',
      '$1 send?',
      'retry? ',
      '$1 try again? ',
      'was cancelled because it is out of stock. ',
      'because ',
      'due to ',
      'total is now $1. click ok to continue. ',
      'be put on hold ',
      'refund will be put on ',
      'free plan will be activated ',
      'ad-free plan will be activated ',
      'free will start ',
      'will renew today unless ',
      'renews now, otherwise ',
      '無料プランに移行',
      '改用免费',
      '무료 요금제로 바꾸',
      '바꾸시려면 취소를 누르세요',
      '바꾸시려면 ',
      'but your $1 ',
      'but the remaining $1 ',
      'last payment: $1 ',
      'previous payment of $1 ',
      'r2 ',
      'rm 1 ',
      'r49 ',
      'tel ',
      '2-step verification method ',
      '2-step verification phone ',
      'code ',
      'billing period ($1/month) ',
      'billing cycle ',
      'payment of $1 will be refunded ',
      "payment of $1 won't be refunded ",
      'payment of $1 x x x x ',
      'お支払い金額',
      '支付金额',
      '付款金额',
      // Round 19: "or" telling a charge, CJK particles, two-step code words,
      // conditional refunds, ringgit, CJK free trials and moves, free starts,
      // repeats, refund totals, money given back after a move, retries, the
      // CJK Cancel button, order questions, top-ups, rentals, orders placed,
      // tips to someone, charges that stop and payments denied.
      'cancel to go back or your card will be charged $1 ',
      ' or you will ',
      ' otherwise we ',
      ' or else ',
      "or we'll place ",
      ' or select ',
      ' or enter ',
      ' and select pay ',
      'or the $1 payment will go through ',
      'お支払い金額は1円',
      '支付金额为¥1',
      '결제 금액은 1원',
      '金額は',
      'code from your phone ',
      'country/area code ',
      'input_',
      'character 1 of 6 ',
      'payment of $1 will be refunded in full if ',
      'refunded if ',
      'payment of $1 on march 3 will be cancelled ',
      'rm8 ',
      'tip rm2 ',
      'rp5 ',
      'r5 ',
      '무료 체험으로 변경',
      '無料体験に切り替え',
      '切换到免费试用',
      '1개월 무료 프로 요금제로 변경',
      'free premium will start today. ',
      'free premium will start today. your current plan: $1. ',
      'your plan ($1) ends. ',
      'free pro starts today. then $1. ',
      'free premium will be activated for 30 days, then $1 ',
      'repeat last payment: $1 ',
      'previous payment: $1. repeat it? ',
      'send again? ',
      'refund total: $1. ',
      'total refunded: $1 ',
      'order total: $1 will be refunded ',
      'total: $1 (refund to ',
      'and get a prorated refund of $1 ',
      'and keep your $1 credit ',
      '환불 1원',
      "and you'll no longer pay $1 ",
      'try again? ',
      'payment $1 retry? ',
      '、戻る場合は「キャンセル」を押してください',
      '돌아가려면 취소를 누르세요, ',
      '返回请点“取消”，',
      'キャンセル',
      '주문하시겠습니까',
      '注文しますか',
      'ご注文を送信',
      'add $1 to your wallet ',
      'rent x for $1 ',
      'your order will be placed ',
      'tip your rider rm3 ',
      'charge will stop ',
      'billing period ends ',
      "won't be charged your next payment of $1 ",
      'no longer pay ',
      // Round 20: the CJK Cancel button's windows and their stops, declined
      // cards, payments that cannot be called off, until-OK objects, charges
      // that stop beside a fee, longer "or" subjects, phone heads and shapes,
      // the plan as it stands, CJK refund totals, receipts resent, past orders
      // repeated, 주문 with a particle, dashes, past order notices, rentals,
      // top-up targets, plans kept and free trials.
      '확인 버튼을 누르면 49,000원이 결제되며 취소 버튼을 누르면 ',
      '취소를 누르면 돌아가고 확인을 ',
      '「キャンセル」を押さないと980円',
      '确认购买请点“确定” 返回请点“取消”',
      '결제를 취소하시려면 취소 버튼을 눌러 ',
      ', 취소를 누르',
      '1.취소를 누르',
      'card declined $1 retry? ',
      'insufficient funds ',
      'authorization ',
      'payment of $1 cannot be cancelled ',
      'payment of $1 can only be cancelled ',
      'unless cancelled ',
      "won't be charged your first payment of $1 until you click ok ",
      'charges will end and a fee of $1 ',
      'billing will stop ',
      'or your card on file will be charged $1 ',
      "or you'll automatically be charged ",
      ' or $1 will be deducted ',
      'or $1 is charged ',
      "or we'll go ahead and charge ",
      ' or your order goes through ',
      'mobile number ',
      'enter 10-digit mobile number ',
      '+1 555 555 5555 ',
      '(555) 555-5555 ',
      'phone number to receive codes ',
      'stays active until then. ',
      'your last payment was $1. ',
      '3월 3일까지 ',
      '3月3日まで',
      '至3月3日',
      'if you change your mind ',
      'already been charged $1 ',
      '환불 합계는 1원',
      '返金合計は1円',
      '退款总额为¥1',
      'resend receipt? ',
      'last payment: $1 repeat it? ',
      'last order: $1 reorder? ',
      '주문이 완료되고 ',
      '주문이 완료되었습니다 ',
      ' - pro is $1 ',
      'ご注文を完了しました',
      '已下单',
      '下单成功',
      "you'll keep premium ($1) until then ",
      'add $1 to your credit card limit ',
      'rent dune (hd) ',
      'the free pro trial ',
      // Round 20 addendum: an account topped up, money moved between accounts.
      'add $1 to your paypal account ',
      'add $1 to your account limit ',
      'move $1 to savings ',
      'move $1 from checking to savings ',
      'move money of $1 to ',
      'move the $1 item to ',
      // Round 21: full-width signs and digits, payments proceeded with,
      // recharges and orders for an amount, amounts due, a Korean total, a
      // payment given back with an adverb or beside another thing called off,
      // the CJK Cancel windows across a pay page, a date or a press not made,
      // the pieces before a Cancel button, stopped and unpaid clauses ended at
      // "and", refund totals by clause, a resend beside a repeat, a price
      // that stands until, phone heads and code boxes, past payments given
      // back, and an account by its number.
      '＄1 ',
      '￡1 ',
      '４，',
      '１．２',
      'proceed with your $1 payment ',
      'continue with payment ',
      'order 2 x for $1 ',
      'order for $1 or more ',
      'recharge ₹1 ',
      'recharge now ',
      'proceed to recharge ',
      'add $1 to your account number ',
      '주문이 완료된 ',
      'due today: $1 ',
      '$1 is due today ',
      '$1 is now due ',
      'refund of $1 is due ',
      '총 1원',
      'payment of $1 will only be refunded ',
      'payment of $1 for the cancelled ',
      'payment of $1 was successfully refunded ',
      '결제 페이지로 돌아가려면 취소를 누르세요',
      'お支払い画面に戻る場合は「キャンセル」',
      '취소를 누르면 3월 3일에 ',
      '취소를 누르지 않으면 ',
      'キャンセルを押さないと',
      '不点击取消',
      '点击取消返回否则',
      "취소를 누르면 '예'를 ",
      '취소를 누르면 그렇지 않으면 ',
      '자동결제를 취소',
      '取消支付页面',
      'no longer pay $1 for basic, and pro costs $1 ',
      "won't be charged and fee $1 ",
      "won't be charged and your last charge of $1 ",
      'charges will end. ',
      'refund total: $1, amount due: $1 ',
      'refund total $1 / payment amount $1 ',
      '환불 금액 1원, ',
      'repeat last payment: $1? we will send a receipt ',
      'pro is $1 until the end ',
      'keep premium ($1) until then ',
      'phone number ending in 34 ',
      'enter the code ',
      '123456 ',
      '결제하신 1원은 3일 이내에 환불',
      '已支付的¥1将原路退回',
      '支払った1円は返金',
      '결제한 1원은 환불되지 않',
      '已支付的¥1不予退款',
      '支払った1円は払い戻しできません',
      // Round 21 addendum: amounts confirmed, approved or authorized, bets
      // and wagers with an amount, counts of items with their amount, and
      // 消费 with an amount.
      'confirm $1? ',
      'confirm $1 now. ',
      'approve the $1 transaction ',
      'authorize a $1 charge ',
      'bet $1 on ',
      'wager $1 ',
      'place a $1 bet ',
      '2 items - $1 ',
      '3 items · $1 ',
      '本次消费¥1',
      '消费金额：¥1',
      // Round 22: 주문 완료 told as a state, a "but" after a stop, charges going
      // away, 총 beside a discount, refund and paid totals, amounts due,
      // returns and exchanges, a plan's price told as ending or kept until a
      // date, digits counted, orders for an amount, CJK pay verbs, charges
      // told actively, order summaries and subtotals.
      '주문이 완료되어 배송을 준비하고 있습니다 ',
      '주문이 완료된 상품 ',
      '주문이 완료되어 ',
      '1,000원을 충전하시겠습니까 ',
      '1원을 보내시겠습니까 ',
      '1원 충전 ',
      '1円チャージ ',
      '1円を送りますか ',
      'チャージしますか ',
      '배터리를 충전하시겠습니까 ',
      'charge $1 ',
      'track order for $1 ',
      'order 123 for $1 - ',
      'ok to charge your card ',
      'authorize this charge ',
      '총 1원이 할인 ',
      '환불 예정 금액은 총 1원 ',
      '本月消费¥1',
      '共计¥1',
      'order summary: 1 items, $1 ',
      'subtotal $1 + tax $1 = $1 ',
      'total due today: $1 ',
      '$1 due today ',
      '추가 결제 금액 1원 ',
      'return this item? order total: $1, refund total: $1. ',
      '반품하시겠습니까? 결제 금액: 1원, 환불 금액: 1원 ',
      'exchange ',
      'your plan ($1/month) ends ',
      'premium ($1/month) is yours until march 3 ',
      '3월 3일까지입니다 ',
      'then ',
      "you won't be charged and the $1 charge will be reversed ",
      'no longer pay $1, but $1 is due today ',
      'your order of $1 will be placed ',
      'enter the 6 digits ',
      '10 digits ',
      // Round 23: charges told as not going away or going away on a
      // condition, 총 beside a discount note or a discount price, orders
      // listed with or without their status, named orders placed or
      // scheduled, and returns for a different size.
      "won't be charged and the fee of $1 will not be waived ",
      "won't be charged and the fee of $1 can't be waived ",
      "won't be charged and the not fee of $1 will be waived ",
      'and the fee of $1 for no reason will never be refunded ',
      '총 1원(할인 적용) ',
      '총 1원 할인가 ',
      '할인가 총 1원 ',
      '할인 금액은 총 1원 ',
      '총 1원이 할인 ',
      'order 123 for $1 - delivered ',
      'order 123 for $1 - free shipping ',
      'repeat last order for $1 ',
      'place the gift order again for $1 ',
      'place your next order for $1 or more ',
      'schedule next order for $1 ',
      "won't be charged and the fee of $1 will be waived if ",
      "won't be charged and the fee of $1 will be waived x ",
      "won't be charged and the $1 charge will not start until ",
      'return this item and get a different size? refund total: $1, order total: $1. ',
      // Round 24: charges going away with what may follow them, and 총 before
      // a discount told as done or not done.
      "won't be charged and the fee of $1 will be waived within 3 days. ",
      "won't be charged and the $1 charge will be refunded to your original payment method automatically. ",
      "won't be charged and the $1 annual fee will not apply. ",
      '총 1원이 할인됩니다 ',
      '총 1원이 할인되지 않습니다 ',
      "won't be charged and the $1 charge will be reversed within 3 to 5 business days. ",
      "won't be charged and the $1 charge will be refunded to your credit card. ",
      "won't be charged and the pending $1 charge will drop off your statement. ",
      "won't be charged and the $1 charge will be refunded to your apple id balance. ",
      "won't be charged and the $1 charge will be refunded within the next few days. ",
      "won't be charged and the $1 charge will be refunded to your card ending in 4242. ",
      // Round 25: card brands and masked endings, a week and "too", 총 told in
      // the future or as processed, and a point before a digit.
      "won't be charged and the $1 charge will be refunded to your visa ending in ****4242. ",
      "won't be charged and the $1 charge will be refunded within a week too. ",
      '총 1원이 환불될 예정입니다 ',
      '총 1원이 환불 처리됩니다 ',
      "won't be charged and the $1 charge will be waived to your card ending in 42.00 if ",
    ]) {
      const text = fill(unit);
      for (const route of routes) {
        const started = performance.now();
        route(text);
        expect(performance.now() - started, JSON.stringify(unit)).toBeLessThan(250);
      }
    }
    // Spaces cannot be split two ways between the end of "check out" and the end.
    const started = performance.now();
    classifyAoiBrowserDriveAction({
      kind: 'click',
      targetText: `check out${' '.repeat(50_000)}x`,
    });
    expect(performance.now() - started).toBeLessThan(250);
    // A word that never ends after "send", a negated clause that never ends, a
    // stopping confirm whose every rate is passed over, a separator that never
    // reaches a name, a stop's words that never reach what it stops, a total's
    // words that never reach an amount, an until clause that never ends, and
    // marks that start a part of a control's words but never a verb.
    for (const text of [
      `send ${'x'.repeat(50_000)}`,
      `won't be charged${'x'.repeat(50_000)}`,
      `cancel ${'$1/month '.repeat(5_000)}`,
      `passport${'-'.repeat(50_000)}name`,
      `as written in their passport${' or passport'.repeat(5_000)}`,
      `cancel ${'x '.repeat(25_000)}`,
      `remove ${'x'.repeat(50_000)}`,
      `keep${' '.repeat(50_000)}x`,
      `give $1${'0'.repeat(50_000)} to a friend`,
      `total${' due'.repeat(12_500)} $1`,
      `total (${'x'.repeat(50_000)}`,
      `taken from your${' x'.repeat(25_000)} account`,
      `won't be charged until${' ok'.repeat(16_000)}`,
      `not${' be'.repeat(16_000)} charged`,
      `${'.'.repeat(50_000)}give $1`,
      `${'\n'.repeat(50_000)}give $1`,
      `check your email for a${' '.repeat(50_000)}code`,
      `get${' x'.repeat(25_000)} for $1`,
      `$1${' x'.repeat(25_000)} will be sent`,
      `while paused${' '.repeat(50_000)}$1`,
      `change your${' x'.repeat(25_000)} budget to $1`,
      `won't be billed until ok${' x'.repeat(25_000)}`,
      `sin${' '.repeat(50_000)}x`,
      `cancel${' x'.repeat(25_000)} purchase`,
      `get x (${' '.repeat(50_000)}$1`,
      `refund of${' '.repeat(50_000)}$1 will be sent`,
      `we've sent${' '.repeat(50_000)}a code`,
      `remove${' x'.repeat(25_000)} plan`,
      `cancel ${'and '.repeat(12_500)}order`,
      `$1${'0'.repeat(50_000)}.`,
      `nothing is charged${' x'.repeat(25_000)} except $1 fee`,
      `${' - '.repeat(16_000)}give $1`,
      `${'👍🏽'.repeat(12_000)} tip $5`,
      `while paused${'x'.repeat(50_000)}`,
      `${'word '.repeat(10_000)}tip $1`,
      `${'a '.repeat(25_000)}$1/month while paused`,
      `tip:${' '.repeat(50_000)}$1`,
      `use $1${' x'.repeat(25_000)} balance`,
      `every${' 2'.repeat(25_000)} weeks`,
      `sin${'-'.repeat(50_000)}required`,
      `we emailed you${' '.repeat(50_000)}a code`,
      // Round 16: a Cancel button's words that never reach what they name, a
      // start told on and on, an amount or a refund's words that never reach
      // their noun or their amount, a negated clause still charged on and on,
      // currency letters, asking words, a reassured price, billed things, a
      // CJK object that never reaches its stop.
      `press${' '.repeat(50_000)}cancel`,
      `if you cancel${' now'.repeat(12_000)}`,
      `cancel${' '.repeat(50_000)}to go back`,
      `or cancel${' to'.repeat(16_000)}`,
      `will be${' upgraded'.repeat(5_000)}`,
      `you'll switch${' you'.repeat(12_000)} to pro`,
      `be upgraded${' x'.repeat(25_000)} anytime`,
      `will start${'ing'.repeat(16_000)}`,
      `make a $1${'0'.repeat(50_000)} payment`,
      `confirm ${'$1 '.repeat(16_000)}order`,
      `submit $1${' monthly'.repeat(6_000)} donation`,
      `refund${' of'.repeat(16_000)} $1`,
      `refund${' the'.repeat(16_000)}`,
      `$1${' credit'.repeat(7_000)} will be sent`,
      `credit${'-'.repeat(50_000)}card`,
      `no${' refunds'.repeat(6_000)}: $1 will be sent`,
      `${'1'.repeat(50_000)}-digit code`,
      `code in${' the'.repeat(16_000)} email`,
      `code from${' x'.repeat(25_000)} authenticator`,
      `we texted a${' confirmation'.repeat(4_000)} code`,
      `won't be charged${' only'.repeat(10_000)}`,
      `won't be charged${' x'.repeat(25_000)} only $1`,
      `${'rs.'.repeat(16_000)}1`,
      `${'rs '.repeat(16_000)}`,
      `how${' to'.repeat(16_000)} give $1`,
      `${'how to '.repeat(7_000)}tip $1`,
      `take${' 3 months'.repeat(5_000)} for $1`,
      `restart${' anytime'.repeat(6_000)} for $1`,
      `rejoin for $1${'0'.repeat(50_000)} later`,
      `started${' x'.repeat(25_000)} today`,
      `cancel this${' transfer'.repeat(5_000)}`,
      `remove${' plan'.repeat(12_000)}`,
      `${'결제'.repeat(25_000)}를 취소`,
      `取消${'订单'.repeat(25_000)}`,
      `关闭${' '.repeat(50_000)}订阅`,
      // Round 16 tuning: a Cancel button's clause that never ends, a cancel
      // whose consequence never comes, sentences that each stop or ask, a
      // told stop whose verb never comes, a clause whose amount never comes, a
      // tip that never ends or never reaches the end, a told start, a total
      // or a year on and on, a code that never comes, a gift's amount, a
      // reason's verb.
      `or cancel to${' x'.repeat(25_000)}`,
      `click cancel to${' keep'.repeat(10_000)}`,
      `if you cancel${' x'.repeat(25_000)}, you will lose`,
      `${'cancel your plan. '.repeat(2_800)}continue?`,
      `${'cancel? '.repeat(6_250)}`,
      `plan${' ($1)'.repeat(10_000)} will end`,
      `won't be charged;${' x'.repeat(25_000)} $1`,
      `won't be charged;${' '.repeat(50_000)}$1`,
      `with a $1${'0'.repeat(50_000)} tip`,
      `with a $1 tip${' '.repeat(50_000)}`,
      `${'with a $1 tip '.repeat(3_500)}x`,
      `upgraded${' to'.repeat(16_000)}`,
      `total is now${' $1'.repeat(12_000)}`,
      `cad ${'2024 '.repeat(10_000)}`,
      `合計${' '.repeat(50_000)}1円`,
      `we sent you a text${' with'.repeat(10_000)} a code`,
      `token${' '.repeat(50_000)}code`,
      `make a gift of${' '.repeat(50_000)}$1`,
      `why i${' give'.repeat(10_000)} $1`,
      // Round 17: a Cancel button's clause that runs on, answers on and on,
      // many sentences beside a told stop, a plan word that never comes, a
      // free tier that never comes, money paid whose amount never comes, a
      // total's qualifiers on and on, a send question far from its amount,
      // an R before endless digits, a "but" whose amount never comes, a kind
      // far from its payment, a step that never ends, CJK stops on and on.
      `press cancel to${' go'.repeat(16_000)} or ok to pay $1`,
      `${'or cancel to x '.repeat(3_000)}`,
      `${'ok '.repeat(16_000)}or cancel.`,
      `${'x. '.repeat(16_000)}will be cancelled.`,
      `${'$1. '.repeat(12_000)}your plan will end.`,
      `select${' x'.repeat(25_000)} plan for $1`,
      `be switched to${' x'.repeat(25_000)} free`,
      `paying${' x'.repeat(25_000)} $1`,
      `total${' incl.'.repeat(8_000)} $1`,
      `$1. send${' '.repeat(50_000)}now?`,
      `r 1${'0'.repeat(50_000)}`,
      `won't be charged, but${' x'.repeat(25_000)} $1`,
      `make an extra${' '.repeat(50_000)}$1 payment`,
      `2${'-'.repeat(50_000)}step verification`,
      `${'取消'.repeat(25_000)}自动扣费`,
      `정기결제(${'월'.repeat(50_000)})를 해지`,
      // Round 18: a Cancel clause that never meets another answer, a move
      // whose price never comes, amounts of nothing on and on, many sentences
      // before a total, many reported causes, a send question far from its
      // mark, a "but" whose amount never comes, a payment whose refund never
      // comes, a past payment far from its label, an R before endless digits,
      // a Korean condition that never meets Cancel, a free plan far from its
      // move, two-step words on and on, a billing word far from its period,
      // and a free plan that is never activated.
      `press cancel to${' go'.repeat(16_000)} and click pay $1`,
      `cancel to go back${' and'.repeat(12_000)} or pay $1`,
      `be upgraded to pro${' x'.repeat(25_000)} $1`,
      `be moved to basic ${'$0 '.repeat(16_000)}`,
      `${'x. '.repeat(16_000)}total: $1 (taxes may apply).`,
      `${'one item was cancelled because it is out of stock. '.repeat(1_000)}total: $1.`,
      `send${' '.repeat(50_000)}?`,
      `won't be charged, but the${' remaining'.repeat(5_000)} $1`,
      `payment of $1${' will'.repeat(10_000)} refunded`,
      `last${' '.repeat(50_000)}payment: $1`,
      `r ${'1'.repeat(50_000)}`,
      `바꾸${'시'.repeat(50_000)}려면 취소를 누르세요`,
      `무료${' '.repeat(50_000)}로 바꾸`,
      `${'2-step verification '.repeat(2_500)}method`,
      `billing${' '.repeat(50_000)}period`,
      `free${' plan'.repeat(10_000)} will be activated`,
      // Round 19: a Cancel clause whose "or" never tells a charge, a label
      // far from its amount, a refund whose condition never comes, a free
      // start before many sentences or many free starts with no price, a free
      // target far from its move, many Cancel buttons described, a refund's
      // total far from its words, a retry far from its mark, a top-up far
      // from its wallet, and a free move before many clauses.
      `press cancel to${' go'.repeat(16_000)} or your card will be charged $1`,
      `cancel to go back or${' x'.repeat(25_000)} will be charged`,
      `お支払い金額は${' '.repeat(50_000)}4,900円`,
      `payment of $1${' x'.repeat(25_000)} refunded if`,
      `free premium will start today.${' x.'.repeat(16_000)} $1`,
      `${'free plan starts. '.repeat(3_000)}`,
      `무료${' 요금제'.repeat(10_000)}로 변경`,
      `${'합계: 1원, '.repeat(5_000)}돌아가려면 취소를 누르세요`,
      `${'、'.repeat(50_000)}キャンセルを押して`,
      `refund${' total'.repeat(10_000)}: $1`,
      `total${' x'.repeat(25_000)} will be refunded`,
      `retry${' '.repeat(50_000)}?`,
      `add $1 to${' x'.repeat(25_000)} wallet`,
      `be switched to free${', and x'.repeat(8_000)} $1`,
      // Round 20: many Cancel buttons described, a Cancel button far past the
      // windows, many clause marks, a payment whose call-off never comes, an
      // until clause that never ends, a stopped charge whose fee never comes,
      // an "or" whose verb never comes, phone words on and on, a free start
      // before many plans kept, a refund label far from its total, a resend
      // far from its receipt, and many sentences before a refund total.
      `${'취소를 누르면 '.repeat(5_000)}확인`,
      `${'가'.repeat(50_000)}취소를 누르세요`,
      `${'、'.repeat(25_000)}キャンセルを押して`,
      `payment of $1${' cannot'.repeat(8_000)} cancelled`,
      `won't be charged your first payment of $1 until${' x'.repeat(25_000)}`,
      `charges will end${' x'.repeat(25_000)} and $1 fee`,
      `press cancel to go back or${' x'.repeat(25_000)} will be charged`,
      `${'phone number '.repeat(4_000)}`,
      `${'+1 '.repeat(16_000)}`,
      `free plan will start.${' stays active until then.'.repeat(2_000)} $1`,
      `退款${'总'.repeat(50_000)}额为¥1`,
      `resend${' the'.repeat(16_000)} receipt?`,
      `${'x. '.repeat(16_000)}refund total: $1.`,
      // Round 20 addendum: a move whose destination never comes, and a top-up
      // whose account is far from its amount.
      `move $1 from${' x'.repeat(25_000)} to savings`,
      `add $1 to${' x'.repeat(25_000)} account`,
      // Round 21: CJK Cancel windows full of stopped things or pay pages,
      // negated clauses whose charge or amount never comes, an unpaid clause
      // that never ends, a refund total before many clauses, a payment whose
      // "be" never comes, a paid amount whose refund never comes, phone and
      // code heads that never end, dates on and on after Cancel, an amount far
      // from its due, an order far from its amount, a recharge far from its
      // "now", a payment far from its "proceed with", full-width digits on and
      // on, and a price far from its "until then".
      `${'자동결제를 취소'.repeat(15)}、`.repeat(400),
      `${'取消支付页面'.repeat(10)}、`.repeat(800),
      `won't be charged${' and fee'.repeat(6_000)}`,
      `won't be charged${' and $1'.repeat(7_000)}`,
      `no longer pay${' x'.repeat(25_000)}`,
      `refund total: $1${', x'.repeat(16_000)}`,
      `payment of $1${' x'.repeat(25_000)} be refunded`,
      `결제하신 1원${'은'.repeat(50_000)} 환불`,
      `phone number${' '.repeat(50_000)}ending`,
      `enter${' '.repeat(50_000)}code`,
      `취소를 누르면 ${'3월'.repeat(16_000)}`,
      `$1${' '.repeat(50_000)}is due today`,
      `due${' '.repeat(50_000)}: $1`,
      `order${' 1'.repeat(25_000)} for $1`,
      `recharge${' '.repeat(50_000)}now`,
      `proceed with${' the'.repeat(16_000)} payment`,
      `${'４'.repeat(50_000)}円`,
      `pro is $1 until${' '.repeat(50_000)}then`,
      // Round 21 addendum: a confirmed amount far from its question mark, a
      // bet far from its amount or its noun, counts of items on and on, and
      // 消费 on and on.
      `confirm $1${' '.repeat(50_000)}x`,
      `bet${' a'.repeat(25_000)} $1`,
      `place a $1${' '.repeat(50_000)}bet`,
      `${'2 items - '.repeat(5_000)}$1`,
      `本次${'消费'.repeat(25_000)}¥1`,
      // Round 22: a completed order whose state never comes, a send far from
      // its amount, a charge far from its amount, an order's count on and on,
      // 총 far from its amount or its discount, a subtotal far from its sum, an
      // amount far from its due, many paid totals beside a refund, a plan's
      // price that never closes, a plan kept far from its until, charges going
      // away on and on, a payment no longer made far from its "but", an order
      // far from its amount, and a code's length far from its digits.
      `주문이 완료되어${' 준'.repeat(16_000)}고 있습니다`,
      `${'1'.repeat(50_000)}원을 보내시겠습니까`,
      `charge${' '.repeat(50_000)}$1`,
      `order${' 1'.repeat(25_000)} for $1 - x`,
      `총${' '.repeat(50_000)}1원`,
      `환불 예정 금액은${' '.repeat(50_000)}총 1원`,
      `총 1원${' '.repeat(50_000)}할인`,
      `subtotal${' x'.repeat(25_000)} = $1`,
      `$1${' '.repeat(50_000)}due today`,
      `return this item? ${'order total: $1, '.repeat(3_000)}refund total: $1.`,
      `your plan (${'x'.repeat(50_000)}) ends`,
      `premium ($1)${' '.repeat(50_000)}is yours until march 3`,
      `won't be charged and the${' $1'.repeat(16_000)} charge will be reversed`,
      `won't be charged and the $1 charge will be reversed${' x'.repeat(25_000)} $1`,
      `no longer pay $1${' '.repeat(50_000)}but $1 is due today`,
      `your order of${' '.repeat(50_000)}$1 will be placed`,
      `enter${' the'.repeat(16_000)} 6 digits`,
      `${'1'.repeat(40)}원을 보내 `.repeat(1_100),
      `$${'1'.repeat(40)} due today `.repeat(1_000),
      `$${'1'.repeat(40)} is now due `.repeat(1_000),
      // Round 23: a negation among a charge's words on and on, 총 far from its
      // discount or far after a discount's label, an order's status far from
      // its dash, a named order far from its verb or its amount, a return far
      // from its different size, a condition far after a charge going away or
      // conditions on and on, and many charges going away before a condition.
      `won't be charged and the fee of${" can't".repeat(8_000)} be waived`,
      `won't be charged and the${' not'.repeat(12_000)} fee will be waived`,
      `won't be charged and the fee of $1${' no'.repeat(16_000)} be waived`,
      `총 1원이${' '.repeat(50_000)}할인`,
      `총 1원 할인${' '.repeat(50_000)}가`,
      `할인${' '.repeat(50_000)}총 1원`,
      `할인 금액은${' '.repeat(50_000)}총 1원`,
      `order 123 for $1 -${' '.repeat(50_000)}delivered`,
      `order 123 for $1${' '.repeat(50_000)}- delivered`,
      `repeat${' last'.repeat(10_000)} order for $1`,
      `repeat last order${' again'.repeat(8_000)} for $1`,
      `place the gift order for${' '.repeat(50_000)}$1`,
      `return this item? ${'another '.repeat(6_000)}size. refund total: $1, order total: $1.`,
      `won't be charged and the fee of $1 will be waived${' x'.repeat(25_000)} if`,
      `won't be charged and the fee of $1 will be waived${' when'.repeat(10_000)}`,
      `${"won't be charged and the fee will be waived ".repeat(1_200)}if`,
      // Round 24: a charge going away far from its sentence's end, its tails
      // on and on, a tail that never ends, and 총's predicate that never comes.
      `won't be charged and the fee of $1 will be waived${' '.repeat(50_000)}x`,
      `won't be charged and the fee of $1 will be waived${' within 3 days'.repeat(3_000)}`,
      `won't be charged and the fee of $1 will be waived${' in'.repeat(16_000)} full`,
      `총 1원이 할인되${'지'.repeat(50_000)}`,
      `총 1원 할인${' '.repeat(50_000)}.`,
      `won't be charged and the $1 charge will be reversed within 3${' to'.repeat(16_000)} 5 days`,
      `won't be charged and the $1 charge will be refunded to your${' credit'.repeat(7_000)} card`,
      `won't be charged and the $1 charge will drop off${' your'.repeat(10_000)} statement`,
      `won't be charged and the $1 charge will be refunded to your${' x'.repeat(25_000)} card`,
      `won't be charged and the $1 charge will be refunded to your ${'x'.repeat(50_000)} card`,
      `won't be charged and the $1 charge will be refunded to your${' bank-account'.repeat(4_000)}`,
      `won't be charged and the $1 charge will be refunded to your card ending in${' 4'.repeat(25_000)}`,
      `won't be charged and the $1 charge will be refunded within the next${' a few'.repeat(8_000)} days`,
      // Round 25: a masked ending that never reaches its digits, "with" on and
      // on, 처리 on and on, 수 on and on, and points and digits on and on.
      `won't be charged and the $1 charge will be refunded to your card ending in ${'*'.repeat(50_000)}4242`,
      `won't be charged and the $1 charge will be refunded to your card ending${' with'.repeat(10_000)} 4242`,
      `총 1원이 환불${' 처리'.repeat(16_000)}됩니다`,
      `총 1원이 환불될${' 수'.repeat(25_000)} 없습니다`,
      `won't be charged and the $1 charge will be refunded to your card ending in 42${'.0'.repeat(25_000)}`,
    ]) {
      for (const route of routes) {
        const begun = performance.now();
        route(text);
        expect(performance.now() - begun, text.slice(0, 30)).toBeLessThan(250);
      }
    }
  });
});
