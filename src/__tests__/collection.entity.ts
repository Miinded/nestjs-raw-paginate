import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'collection' })
export class CollectionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: false, unique: false })
  name: string;

  @Column({ type: 'bigint', nullable: false })
  sellingPrice: string;

  @Column({ nullable: false, default: 0 })
  fileSizeBytes: number;
}
