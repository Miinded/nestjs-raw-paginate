import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { CollectionEntity } from './collection.entity';
import { OrderRefundEntity } from './orderRefund.entity';
import { OrderState } from './dto';

@Entity({ name: 'order' })
export class OrderEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => CollectionEntity, (s) => s.id, {
    cascade: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn()
  collection: CollectionEntity;

  @Index()
  @Column({
    type: 'enum',
    enum: OrderState,
    default: OrderState.WAITING,
  })
  state: OrderState;

  @Column()
  nftCount: number;

  @Column({ type: 'bigint', nullable: false })
  amount: string;

  @Column({ type: 'bigint', nullable: false })
  sellingPrice: string;

  @CreateDateColumn()
  createdAt: string;

  @OneToMany(() => OrderRefundEntity, (s) => s.order)
  refunds: OrderRefundEntity[];
}
