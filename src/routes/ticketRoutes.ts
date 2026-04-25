import { Router } from 'express';
import { submitTicketHandler, getTicketStatusHandler } from '../controllers/ticketController.ts';

const router = Router();

router.post('/', submitTicketHandler);
router.get('/:id', getTicketStatusHandler);

export default router;
