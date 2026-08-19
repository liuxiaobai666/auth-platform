import { IsNotEmpty, IsString, Length, MaxLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @IsNotEmpty({ message: '用户名不能为空' })
  @MaxLength(64)
  username!: string;

  @IsString()
  @IsNotEmpty({ message: '密码不能为空' })
  @MaxLength(128)
  password!: string;
}

export class RefreshDto {
  @IsString()
  @IsNotEmpty({ message: 'refresh_token 不能为空' })
  refresh_token!: string;
}

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty({ message: '原密码不能为空' })
  old_password!: string;

  @IsString()
  @Length(10, 128, { message: '新密码长度需在 10 到 128 个字符之间' })
  new_password!: string;
}
