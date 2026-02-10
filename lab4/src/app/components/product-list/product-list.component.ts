import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { Product } from '../../models/product.model';
import { PRODUCTS } from '../../data/products';
import { ProductCardComponent } from '../product-card/product-card.component';

@Component({
  selector: 'app-product-list',
  standalone: true,
  imports: [CommonModule, ProductCardComponent],
  templateUrl: './product-list.component.html',
  styleUrl: './product-list.component.css'
})
export class ProductListComponent {
  products: Product[] = PRODUCTS;
  lastShare = '';

  onShared(e: { productId: number; platform: 'telegram' | 'whatsapp' }) {
    this.lastShare = `Shared #${e.productId} via ${e.platform.toUpperCase()}`;
    setTimeout(() => (this.lastShare = ''), 2000);
  }
}
