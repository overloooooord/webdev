import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, OnInit } from '@angular/core';
import { Product } from '../../models/product.model';

type SharePlatform = 'telegram' | 'whatsapp';

@Component({
  selector: 'app-product-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './product-card.component.html',
  styleUrl: './product-card.component.css'
})
export class ProductCardComponent implements OnInit {
  @Input() product!: Product;
  @Output() shared = new EventEmitter<{ productId: number; platform: SharePlatform }>();

  selectedImage = '';

  ngOnInit(): void {
    this.selectedImage = this.product.image;
  }

  setImage(img: string): void {
    this.selectedImage = img;
  }

  stars(): number[] {
    return [1, 2, 3, 4, 5];
  }

  
  fullStars(): number {
    return Math.floor(this.product.rating);
  }

  //share(platform: SharePlatform): void {
   // const url = encodeURIComponent(this.product.link);
    //const text = encodeURIComponent(this.product.name);

    //if (platform === 'telegram') {
     // window.open(`https://t.me/share/url?url=${url}&text=${text}`, '_blank');
    //} else {
     // window.open(`https://wa.me/?text=${encodeURIComponent('Check out this product: ' + this.product.link)}`, '_blank');
    //}

    //this.shared.emit({ productId: this.product.id, platform });
  //}
}
