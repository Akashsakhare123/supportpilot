import { BadRequestException } from '@nestjs/common';
import { loginSchema } from '@supportpilot/shared';
import { ZodValidationPipe } from './zod-validation.pipe';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(loginSchema);

  it('returns parsed (normalised) data', () => {
    expect(pipe.transform({ email: ' A@B.CO ', password: 'pw' })).toEqual({
      email: 'a@b.co',
      password: 'pw',
    });
  });

  it('throws 400 listing the invalid fields', () => {
    try {
      pipe.transform({ email: 'nope' });
      throw new Error('expected an exception');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse() as { issues: { path: string }[] };
      expect(body.issues.map((i) => i.path).sort()).toEqual(['email', 'password']);
    }
  });
});
