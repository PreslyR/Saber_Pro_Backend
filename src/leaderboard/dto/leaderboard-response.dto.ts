import { ApiProperty } from '@nestjs/swagger';

export class LeaderboardEntryDto {
  @ApiProperty({ example: 1 })
  rank!: number;

  @ApiProperty({ example: 'ba3f557b-...' })
  userId!: string;

  @ApiProperty({ example: 'Andres Perez' })
  username!: string;

  @ApiProperty({ example: 850 })
  xp!: number;

  @ApiProperty({ example: 12 })
  streak!: number;

  @ApiProperty({ example: 4 })
  level!: number;
}

export class LeaderboardResponseDto {
  @ApiProperty({ type: [LeaderboardEntryDto] })
  entries!: LeaderboardEntryDto[];
}
