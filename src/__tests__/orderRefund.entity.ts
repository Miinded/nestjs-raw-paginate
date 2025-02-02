import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { OrderEntity } from './order.entity';
import { CollectionEntity } from './collection.entity';
import { OrderRefundState } from './dto';

@Entity({ name: 'order_refund' })
export class OrderRefundEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: OrderRefundState,
    default: OrderRefundState.VALID,
  })
  state: OrderRefundState;

  @ManyToOne(() => OrderEntity, (s) => s.id)
  @JoinColumn()
  order: OrderEntity;

  @Column({ type: 'bigint', nullable: false })
  refundAmount: string;

  @ManyToOne(() => CollectionEntity, (s) => s.id)
  @JoinColumn()
  collection: CollectionEntity;
}
