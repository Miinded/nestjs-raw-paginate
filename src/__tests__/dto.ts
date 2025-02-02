export enum OrderState {
  WAITING = 'WAITING',
  RECEIVE_ALL_FUNDS = 'RECEIVE_ALL_FUNDS',
  MINTING = 'MINTING',
  COMPLETED = 'COMPLETED',
  EXPIRED = 'EXPIRED',
  REFUND_SOLDOUT = 'REFUND_SOLDOUT',
  PAYOUT = 'PAYOUT',
}

export enum OrderControlState {
  RECHECK = 'RECHECK',
  REFUND = 'REFUND',
  REFUNDED = 'REFUNDED',
}

export enum OrderRefundState {
  VALID = 'VALID',
  SENDING = 'SENDING',
  COMPLETED = 'COMPLETED',
}

export class QueryDto {
  orderId: string;
  refundState: string;
  refundAmount: string;
  refundCompleted: number;
  refundValidate: number;
  refundSending: number;
}
