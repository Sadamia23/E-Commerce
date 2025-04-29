import { inject, Injectable } from '@angular/core';
import { ConfirmationToken, loadStripe, Stripe, StripeAddressElement, StripeAddressElementOptions, StripeElements, StripePaymentElement } from '@stripe/stripe-js'
import { environment } from '../../../environments/environment';
import { HttpClient } from '@angular/common/http';
import { CartService } from './cart.service';
import { Cart } from '../../shared/models/cart';
import { firstValueFrom, map } from 'rxjs';
import { AccountService } from './account.service';

@Injectable({
  providedIn: 'root'
})
export class StripeService {
  baseUrl = environment.apiUrl;
  private cartService = inject(CartService);
  private accountService = inject(AccountService);
  private http = inject(HttpClient);
  private stripePromise: Promise<Stripe | null>;
  private elements?: StripeElements;
  private addressElement?: StripeAddressElement;
  private paymentElement?: StripePaymentElement;
  private isInitializing = false; // Flag to prevent concurrent initializations

  constructor() {
    this.stripePromise = loadStripe(environment.stripePublicKey);
  }

  getStripeInstance() {
    return this.stripePromise;
  }

  async initializeElements() {
    // If already initializing, wait for it to complete
    if (this.isInitializing) {
      await new Promise(resolve => {
        const checkInterval = setInterval(() => {
          if (!this.isInitializing) {
            clearInterval(checkInterval);
            resolve(true);
          }
        }, 100);
      });
    }

    if (!this.elements) {
      try {
        this.isInitializing = true;
        const stripe = await this.getStripeInstance();
        if (stripe) {
          const cart = await firstValueFrom(this.createOrUpdatePaymentIntent());
          if (!cart.clientSecret) {
            throw new Error('No client secret returned from payment intent');
          }
          this.elements = stripe.elements({clientSecret: cart.clientSecret, appearance: {labels: 'floating'}});
        } else {
          throw new Error('Stripe has not been loaded');
        }
      } finally {
        this.isInitializing = false;
      }
    }
    return this.elements;
  }

  async createPaymentElement() {
    if (!this.paymentElement) {
      const elements = await this.initializeElements();
      if (elements) {
        this.paymentElement = elements.create('payment');
      } else {
        throw new Error('Element instance has not been initialized')
      }
    }
    return this.paymentElement;
  }

  async createAddressElement() {
    if (!this.addressElement) {
      const elements = await this.initializeElements();
      if (elements) {
        const user = this.accountService.currentUser();
        let defaultValues: StripeAddressElementOptions['defaultValues'] = {};

        if (user) {
          defaultValues.name = user.firstName + ' ' + user.lastName
        }

        if (user?.address) {
          defaultValues.address = {
            line1: user.address.line1,
            line2: user.address.line2,
            city: user.address.city,
            state: user.address.state,
            country: user.address.country,
            postal_code: user.address.postalCode,
          }
        }

        const options: StripeAddressElementOptions = {
          mode: 'shipping',
          defaultValues
        };
        this.addressElement = elements.create('address', options);
      } else {
        throw new Error('elements instance has not been loaded');
      }
    }
    return this.addressElement;
  }

  async createConfirmationToken() {
    const stripe = await this.getStripeInstance();
    const elements = await this.initializeElements();
    if (!elements) throw new Error('Elements have not been initialized');
    
    const result = await elements.submit();
    if (result.error) throw new Error(result.error.message);
    
    if (stripe) {
      return await stripe.createConfirmationToken({elements});
    } else {
      throw new Error('Stripe not available')
    }
  }

  async confirmPayment(confirmationToken: ConfirmationToken) {
    const stripe = await this.getStripeInstance();
    if (!stripe) {
      throw new Error('Stripe instance is not available');
    }

    const elements = await this.initializeElements();
    if (!elements) {
      throw new Error('Elements have not been initialized');
    }

    const result = await elements.submit();
    if (result.error) throw new Error(result.error.message);

    const cart = this.cartService.cart();
    const clientSecret = cart?.clientSecret;

    if (!clientSecret) {
      // Try to refresh the client secret if not available
      await firstValueFrom(this.createOrUpdatePaymentIntent());
      const updatedCart = this.cartService.cart();
      if (!updatedCart?.clientSecret) {
        throw new Error('Client secret is not available');
      }
    }

    // Get the latest client secret after potential refresh
    const finalClientSecret = this.cartService.cart()?.clientSecret;
    
    if (stripe && finalClientSecret) {
      return await stripe.confirmPayment({
        clientSecret: finalClientSecret,
        confirmParams: {
          confirmation_token: confirmationToken.id
        },
        redirect: 'if_required'
      });
    } else {
      throw new Error('Unable to load stripe or obtain client secret');
    }
  }

  createOrUpdatePaymentIntent() {
    const cart = this.cartService.cart();
    if (!cart) throw new Error('Problem with cart');
    
    const hasClientSecret = !!cart?.clientSecret;
    return this.http.post<Cart>(this.baseUrl + 'payments/' + cart.id, {}).pipe(
      map(cart => {
        this.cartService.setCart(cart); // Always update the cart to ensure we have the latest client secret
        return cart;
      })
    );
  }

  disposeElements() {  
    // Do not dispose elements if in the middle of a payment flow
    // Only dispose if we're sure we're done with the checkout process
    if (this.elements) {
      this.elements = undefined;
      this.addressElement = undefined;
      this.paymentElement = undefined;
    }
  }
}