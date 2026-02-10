import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { ProductCardComponent } from '../../components/product-card/product-card.component';
import { PRODUCTS } from '../../data/products';
import { Product } from '../../models/product.model';
import { FormsModule } from '@angular/forms';



type SortKey = 'popular' | 'priceAsc' | 'priceDesc' | 'ratingDesc';

@Component({
  selector: 'app-catalog-page',
  standalone: true,
  imports: [CommonModule, FormsModule, ProductCardComponent],
  templateUrl: './catalog.component.html',
  styleUrl: './catalog.component.css'
})
export class CatalogComponent {
  query = '';
  sort: SortKey = 'popular';

  categories = [
    'ВСЕ КАТЕГОРИИ', 'ТЕЛЕФОНЫ И ГАДЖЕТЫ', 'БЫТОВАЯ ТЕХНИКА', 'ТВ, АУДИО, ВИДЕО',
    'КОМПЬЮТЕРЫ', 'МЕБЕЛЬ', 'КРАСОТА, ЗДОРОВЬЕ', 'ДЕТСКИЕ ТОВАРЫ', 'АПТЕКА'
  ];

  priceRanges = [
    'до 10 000 ₸',
    '10 000 - 49 999 ₸',
    '50 000 - 99 999 ₸',
    '100 000 - 149 999 ₸',
    '150 000 - 199 999 ₸',
    '200 000 - 499 999 ₸',
    'более 500 000 ₸'
  ];

  brands = ['Arctic', 'Deepcool', 'GIGABYTE', 'ID-COOLING', 'Kingston', 'MSI'];

  get filtered(): Product[] {
    const q = this.query.trim().toLowerCase();
    let list = PRODUCTS.filter(p =>
      !q || p.name.toLowerCase().includes(q) 
    );

    if (this.sort === 'priceAsc') list = [...list].sort((a,b) => a.price - b.price);
    if (this.sort === 'priceDesc') list = [...list].sort((a,b) => b.price - a.price);
    if (this.sort === 'ratingDesc') list = [...list].sort((a,b) => b.rating - a.rating);

    return list;
  }
}
