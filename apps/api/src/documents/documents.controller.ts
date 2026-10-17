import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  type AddUrlDocumentInput,
  addUrlDocumentSchema,
  type DocumentSummary,
  UPLOAD_LIMITS,
} from '@supportpilot/shared';
import type { AuthContext } from '../auth/auth.types';
import { Auth, Roles } from '../auth/decorators';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DocumentsService } from './documents.service';

/** The parts of a multer file we use (memory storage). */
interface UploadedFileData {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/** Knowledge base management: admins and owners. */
@Controller('documents')
@Roles('admin')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  list(@Auth() auth: AuthContext): Promise<DocumentSummary[]> {
    return this.documents.list(auth.tenantId);
  }

  /** multipart/form-data: file (PDF, .txt, .md, max 10 MB) and optional title. */
  @Post()
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: UPLOAD_LIMITS.maxBytes, files: 1, fields: 5 } }),
  )
  upload(
    @Auth() auth: AuthContext,
    @UploadedFile() file: UploadedFileData | undefined,
    @Body('title') title: string | undefined,
  ): Promise<DocumentSummary> {
    return this.documents.upload(auth, file, title);
  }

  @Post('url')
  addUrl(
    @Auth() auth: AuthContext,
    @Body(new ZodValidationPipe(addUrlDocumentSchema)) body: AddUrlDocumentInput,
  ): Promise<DocumentSummary> {
    return this.documents.addUrl(auth, body);
  }

  @Post(':id/reindex')
  @HttpCode(HttpStatus.OK)
  reindex(
    @Auth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<DocumentSummary> {
    return this.documents.reindex(auth.tenantId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Auth() auth: AuthContext, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.documents.remove(auth.tenantId, id);
  }
}
