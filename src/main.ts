import './styles.css';
import { mountApp } from './app';
import { store } from './lib/store';

async function bootstrap(): Promise<void> {
  await store.reload();
  mountApp(document.getElementById('app')!);
}

void bootstrap();
